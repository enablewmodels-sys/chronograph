//! Command line executor for a portable decoder artifact.
//!
//! Reads raw little-endian samples for one window and prints the decoded result as JSON.
//! It never trains, never downloads weights and never contacts a network service.

use chronograph_decoder::{Decoded, Decoder, Error};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage:\n  chronograph-decode --artifact DIR --describe\n  chronograph-decode --artifact DIR --input FILE [--dtype f32|f64]\n\n  --input is one window of channel-major raw little-endian samples.\n  Channel count, window length and sample rate come from the artifact.";

fn decoded_json(result: &Decoded) -> serde_json::Value {
    serde_json::json!({
        "text": result.text,
        "label": result.label,
        "probability": result.probability,
        "abstained": result.abstained,
        "tokens": result
            .tokens
            .iter()
            .map(|t| serde_json::json!({
                "slot": t.slot,
                "token": t.token,
                "probability": t.probability,
                "abstained": t.abstained,
            }))
            .collect::<Vec<_>>(),
    })
}

fn run() -> Result<(), Error> {
    let mut artifact: Option<PathBuf> = None;
    let mut input: Option<PathBuf> = None;
    let mut dtype = "f32".to_owned();
    let mut describe = false;
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--artifact" => artifact = arguments.next().map(PathBuf::from),
            "--input" => input = arguments.next().map(PathBuf::from),
            "--dtype" => dtype = arguments.next().unwrap_or_default(),
            "--describe" => describe = true,
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(());
            }
            other => return Err(Error::Invalid(format!("unknown argument {other}"))),
        }
    }
    let artifact =
        artifact.ok_or_else(|| Error::Invalid("--artifact DIR is required".to_owned()))?;
    let decoder = Decoder::open(&artifact)?;
    let (channels, window_samples, rate) = decoder.geometry();
    let (adapter, version) = decoder.adapter();
    if describe {
        let value = serde_json::json!({
            "adapter": adapter,
            "version": version,
            "channels": channels,
            "channel_names": decoder.channels(),
            "window_samples": window_samples,
            "hop_samples": decoder.hop_samples(),
            "sample_rate_hz": rate,
            "limits": decoder.limits(),
        });
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    let input = input.ok_or_else(|| Error::Invalid("--input FILE is required".to_owned()))?;
    let bytes = std::fs::read(&input)?;
    let expected = channels * window_samples;
    let window: Vec<f64> = match dtype.as_str() {
        "f32" => {
            if bytes.len() != expected * 4 {
                return Err(Error::Invalid(format!(
                    "--input holds {} bytes; {expected} f32 values are required",
                    bytes.len()
                )));
            }
            bytes
                .chunks_exact(4)
                .map(|c| f64::from(f32::from_le_bytes(c.try_into().unwrap())))
                .collect()
        }
        "f64" => {
            if bytes.len() != expected * 8 {
                return Err(Error::Invalid(format!(
                    "--input holds {} bytes; {expected} f64 values are required",
                    bytes.len()
                )));
            }
            bytes
                .chunks_exact(8)
                .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
                .collect()
        }
        other => return Err(Error::Invalid(format!("unknown dtype {other}"))),
    };
    let result = decoder.decode(&window)?;
    println!("{}", serde_json::to_string(&decoded_json(&result))?);
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("chronograph-decode: {error}");
            eprintln!("{USAGE}");
            ExitCode::FAILURE
        }
    }
}
