//! WebAssembly binding for the portable decoder executor.
//!
//! The browser runs the SAME artifact reader as Python and the native binary; this crate
//! contributes only a linear-memory ABI, so a decoded result cannot differ by runtime. A
//! caller allocates a buffer, writes the artifact and one window, calls in, and reads a JSON
//! result out of the returned pointer.
//!
//! There is no filesystem here, which is why the reader takes bytes rather than a directory.
#![deny(missing_docs)]

use chronograph_decoder::Decoder;
use std::sync::Mutex;

/// Last result or error message, read by the host after a call.
static RESULT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

fn buffer() -> std::sync::MutexGuard<'static, Vec<u8>> {
    match RESULT.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn store(value: &serde_json::Value) -> i32 {
    let mut guard = buffer();
    guard.clear();
    guard.extend_from_slice(value.to_string().as_bytes());
    0
}

fn fail(message: String) -> i32 {
    let mut guard = buffer();
    guard.clear();
    guard.extend_from_slice(message.as_bytes());
    1
}

/// Borrow host memory. The host owns the linear memory and passes lengths it allocated.
///
/// # Safety
/// The pointer must reference `length` readable bytes for the duration of the call.
unsafe fn slice<'a>(pointer: *const u8, length: usize) -> Option<&'a [u8]> {
    if pointer.is_null() {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(pointer, length) })
}

/// The artifact format this module executes.
#[unsafe(no_mangle)]
pub extern "C" fn chronograph_format_ptr() -> *const u8 {
    b"decoder-v1".as_ptr()
}

/// Length of the format string returned by chronograph_format_ptr.
#[unsafe(no_mangle)]
pub extern "C" fn chronograph_format_len() -> usize {
    b"decoder-v1".len()
}

/// Allocate bytes for the host to write into. Free with chronograph_free.
#[unsafe(no_mangle)]
pub extern "C" fn chronograph_alloc(length: usize) -> *mut u8 {
    let mut owned = Vec::<u8>::with_capacity(length);
    let pointer = owned.as_mut_ptr();
    std::mem::forget(owned);
    pointer
}

/// Release a buffer from chronograph_alloc with the same length.
///
/// # Safety
/// The pointer must come from chronograph_alloc with the same length, and be freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn chronograph_free(pointer: *mut u8, length: usize) {
    if pointer.is_null() {
        return;
    }
    drop(unsafe { Vec::from_raw_parts(pointer, 0, length) });
}

/// Pointer to the last result. Valid until the next call.
#[unsafe(no_mangle)]
pub extern "C" fn chronograph_result_ptr() -> *const u8 {
    buffer().as_ptr()
}

/// Length of the last result.
#[unsafe(no_mangle)]
pub extern "C" fn chronograph_result_len() -> usize {
    buffer().len()
}

/// Describe an artifact: adapter, geometry and limits. Returns 0 on success.
///
/// # Safety
/// Both pointers must reference the given number of readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn chronograph_describe(
    model_json: *const u8,
    model_len: usize,
    weights: *const u8,
    weights_len: usize,
) -> i32 {
    let (Some(model), Some(blob)) = (unsafe { slice(model_json, model_len) }, unsafe {
        slice(weights, weights_len)
    }) else {
        return fail("null artifact buffer".to_owned());
    };
    let decoder = match Decoder::from_bytes(model, blob) {
        Ok(decoder) => decoder,
        Err(error) => return fail(error.to_string()),
    };
    let (channels, window_samples, rate) = decoder.geometry();
    let (adapter, version) = decoder.adapter();
    store(&serde_json::json!({
        "adapter": adapter,
        "version": version,
        "channels": channels,
        "channel_names": decoder.channels(),
        "window_samples": window_samples,
        "hop_samples": decoder.hop_samples(),
        "sample_rate_hz": rate,
        "limits": decoder.limits(),
    }))
}

/// Decode one window of little-endian f64 samples. Returns 0 on success.
///
/// # Safety
/// Every pointer must reference the given number of readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn chronograph_decode(
    model_json: *const u8,
    model_len: usize,
    weights: *const u8,
    weights_len: usize,
    window: *const u8,
    window_len: usize,
) -> i32 {
    let (Some(model), Some(blob), Some(samples)) = (
        unsafe { slice(model_json, model_len) },
        unsafe { slice(weights, weights_len) },
        unsafe { slice(window, window_len) },
    ) else {
        return fail("null artifact or window buffer".to_owned());
    };
    if samples.len() % 8 != 0 {
        return fail("window must be little-endian f64 samples".to_owned());
    }
    let decoder = match Decoder::from_bytes(model, blob) {
        Ok(decoder) => decoder,
        Err(error) => return fail(error.to_string()),
    };
    let values: Vec<f64> = samples
        .chunks_exact(8)
        .map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap()))
        .collect();
    match decoder.decode(&values) {
        Ok(result) => store(&serde_json::json!({
            "text": result.text,
            "label": result.label,
            "probability": result.probability,
            "abstained": result.abstained,
            "tokens": result.tokens.iter().map(|token| serde_json::json!({
                "slot": token.slot,
                "token": token.token,
                "probability": token.probability,
                "abstained": token.abstained,
            })).collect::<Vec<_>>(),
        })),
        Err(error) => fail(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result() -> String {
        String::from_utf8_lossy(unsafe {
            std::slice::from_raw_parts(chronograph_result_ptr(), chronograph_result_len())
        })
        .into_owned()
    }

    #[test]
    fn format_identity_and_result_buffer() {
        assert_eq!(chronograph_format_len(), 10);
        assert_eq!(store(&serde_json::json!({"ok": true})), 0);
        assert_eq!(result(), "{\"ok\":true}");
        assert_eq!(fail("broken".to_owned()), 1);
        assert_eq!(result(), "broken");
    }

    #[test]
    fn rejections_are_reported_rather_than_decoded() {
        let model = b"{}".to_vec();
        let empty: Vec<u8> = Vec::new();
        let code = unsafe { chronograph_describe(model.as_ptr(), model.len(), empty.as_ptr(), 0) };
        assert_eq!(code, 1);
        // The reader's own message survives the ABI: a host can show why it refused.
        assert!(result().contains("format"), "{}", result());
    }
}
