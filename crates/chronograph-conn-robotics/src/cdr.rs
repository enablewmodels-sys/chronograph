//! Checked ROS 2 CDR v1 decoder for sensor_msgs/msg/JointState.
use crate::{Error, Header, JointState, Result, Stamp};
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
    little: bool,
}
impl Reader<'_> {
    fn take(&mut self, n: usize, align: usize) -> Result<&[u8]> {
        let padding = (align - (self.pos - 4) % align) % align;
        let start = self
            .pos
            .checked_add(padding)
            .ok_or_else(|| Error::Invalid("CDR offset overflow".into()))?;
        let end = start
            .checked_add(n)
            .filter(|v| *v <= self.bytes.len())
            .ok_or_else(|| Error::Invalid("truncated CDR field".into()))?;
        self.pos = end;
        Ok(&self.bytes[start..end])
    }
    fn u32(&mut self) -> Result<u32> {
        let little = self.little;
        let bytes = self.take(4, 4)?.try_into().unwrap();
        Ok(if little {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        })
    }
    fn string(&mut self) -> Result<String> {
        let n = self.u32()? as usize;
        if n == 0 || n > 4097 {
            return Err(Error::Invalid(
                "CDR string exceeds 4096 bytes or lacks terminator".into(),
            ));
        }
        let bytes = self.take(n, 1)?;
        if bytes[n - 1] != 0 || bytes[..n - 1].contains(&0) {
            return Err(Error::Invalid("invalid CDR string terminator".into()));
        }
        String::from_utf8(bytes[..n - 1].to_vec())
            .map_err(|_| Error::Invalid("CDR string is not UTF-8".into()))
    }
    fn vector(&mut self) -> Result<Vec<f64>> {
        let n = self.u32()? as usize;
        if n > 4096 {
            return Err(Error::Invalid("CDR vector exceeds 4096 entries".into()));
        }
        (0..n)
            .map(|_| {
                let little = self.little;
                let bytes = self.take(8, 8)?.try_into().unwrap();
                Ok(if little {
                    f64::from_le_bytes(bytes)
                } else {
                    f64::from_be_bytes(bytes)
                })
            })
            .collect()
    }
}
pub fn joint_state(bytes: &[u8]) -> Result<JointState> {
    if bytes.len() < 4
        || bytes.len() > 1024 * 1024
        || !matches!(bytes[..4], [0, 0, 0, 0] | [0, 1, 0, 0])
    {
        return Err(Error::Invalid(
            "require bounded plain CDR v1 (big/little endian); XCDR2/parameter lists unsupported"
                .into(),
        ));
    }
    let mut r = Reader {
        bytes,
        pos: 4,
        little: bytes[1] == 1,
    };
    let sec = r.u32()? as i32;
    let nanosec = r.u32()?;
    let frame_id = r.string()?;
    let n = r.u32()? as usize;
    if n > 4096 {
        return Err(Error::Invalid("too many CDR joint names".into()));
    }
    let name = (0..n).map(|_| r.string()).collect::<Result<Vec<_>>>()?;
    let result = JointState {
        header: Header {
            stamp: Stamp { sec, nanosec },
            frame_id,
        },
        name,
        position: r.vector()?,
        velocity: r.vector()?,
        effort: r.vector()?,
    };
    if bytes.len() - r.pos > 3 || bytes[r.pos..].iter().any(|v| *v != 0) {
        return Err(Error::Invalid("unexpected trailing CDR fields".into()));
    }
    result.validate()?;
    Ok(result)
}
