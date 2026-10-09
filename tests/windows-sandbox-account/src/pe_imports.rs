//! Bounded static import inventory only; never maps or executes a PE image.
use std::collections::BTreeSet;
type Result<T> = std::result::Result<T, String>;
fn range(data: &[u8], start: usize, length: usize) -> Result<&[u8]> {
    data.get(start..start.checked_add(length).ok_or("PE range overflow")?)
        .ok_or_else(|| "PE range outside image".into())
}
fn u16_at(data: &[u8], start: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(
        range(data, start, 2)?.try_into().map_err(|_| "PE u16")?,
    ))
}
fn u32_at(data: &[u8], start: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(
        range(data, start, 4)?.try_into().map_err(|_| "PE u32")?,
    ))
}
struct Section {
    rva: usize,
    raw: usize,
    raw_size: usize,
    virtual_size: usize,
}
pub fn static_imports(data: &[u8]) -> Result<Vec<String>> {
    if data.len() > 128 * 1024 * 1024 || range(data, 0, 2)? != b"MZ" {
        return Err("PE size or DOS signature invalid".into());
    }
    let nt = u32_at(data, 0x3c)? as usize;
    if range(data, nt, 4)? != b"PE\0\0" {
        return Err("PE signature invalid".into());
    }
    let count = u16_at(data, nt + 6)? as usize;
    if count == 0 || count > 96 {
        return Err("PE section budget invalid".into());
    }
    let optional_size = u16_at(data, nt + 20)? as usize;
    let optional = range(data, nt + 24, optional_size)?;
    let (number_offset, directory_offset) = match u16_at(optional, 0)? {
        0x10b => (92, 96),
        0x20b => (108, 112),
        _ => return Err("unsupported PE optional header".into()),
    };
    let headers = u32_at(optional, 60)? as usize;
    let section_offset = nt + 24 + optional_size;
    let table = range(data, section_offset, count * 40)?;
    if headers < section_offset + table.len() || headers > data.len() {
        return Err("PE header extent invalid".into());
    }
    let mut sections: Vec<Section> = vec![];
    for entry in table.chunks_exact(40) {
        let section = Section {
            virtual_size: u32_at(entry, 8)? as usize,
            rva: u32_at(entry, 12)? as usize,
            raw_size: u32_at(entry, 16)? as usize,
            raw: u32_at(entry, 20)? as usize,
        };
        range(data, section.raw, section.raw_size)?;
        let end = section
            .rva
            .checked_add(section.virtual_size.max(section.raw_size))
            .ok_or("PE RVA overflow")?;
        if section.rva < headers
            || sections.iter().any(|other| {
                section.rva < other.rva + other.virtual_size.max(other.raw_size) && other.rva < end
            })
        {
            return Err("PE virtual sections overlap".into());
        }
        sections.push(section);
    }
    let mapped = |rva: usize, size: usize| -> Result<usize> {
        let end = rva.checked_add(size).ok_or("PE RVA overflow")?;
        if rva < headers && end <= headers {
            return Ok(rva);
        }
        let section = sections
            .iter()
            .find(|section| rva >= section.rva && end <= section.rva + section.raw_size)
            .ok_or("PE RVA has no raw backing")?;
        let offset = section
            .raw
            .checked_add(rva - section.rva)
            .ok_or("PE file offset overflow")?;
        range(data, offset, size)?;
        Ok(offset)
    };
    if u32_at(optional, number_offset)? < 2 {
        return Ok(vec![]);
    }
    let import_rva = u32_at(optional, directory_offset + 8)? as usize;
    let import_size = u32_at(optional, directory_offset + 12)? as usize;
    if import_rva == 0 && import_size == 0 {
        return Ok(vec![]);
    }
    if import_rva == 0 || !(20..=1024 * 1024).contains(&import_size) {
        return Err("PE import directory budget invalid".into());
    }
    let mut names = BTreeSet::new();
    for index in 0..=128 {
        if (index + 1) * 20 > import_size {
            return Err("PE import directory lacks terminator".into());
        }
        let rva = import_rva
            .checked_add(index * 20)
            .ok_or("PE import RVA overflow")?;
        let entry = range(data, mapped(rva, 20)?, 20)?;
        if entry.iter().all(|byte| *byte == 0) {
            return Ok(names.into_iter().collect());
        }
        if index == 128 {
            return Err("PE import count exceeds budget".into());
        }
        let name_rva = u32_at(entry, 12)? as usize;
        if name_rva == 0 {
            return Err("PE import name missing".into());
        }
        let mut name = vec![];
        for index in 0..=255 {
            let rva = name_rva.checked_add(index).ok_or("PE name RVA overflow")?;
            let byte = data[mapped(rva, 1)?];
            if byte == 0 {
                break;
            }
            if index == 255 || !(byte.is_ascii_alphanumeric() || b"._-+".contains(&byte)) {
                return Err("PE DLL name is not a bounded basename".into());
            }
            name.push(byte);
        }
        let name = String::from_utf8(name)
            .map_err(|_| "PE import name encoding")?
            .to_ascii_lowercase();
        if !valid_dll_basename(&name) {
            return Err("PE import is not a DLL basename".into());
        }
        names.insert(name);
    }
    Err("PE import count exceeds budget".into())
}
pub fn valid_dll_basename(name: &str) -> bool {
    if name.len() <= 4
        || name.len() > 255
        || !name.ends_with(".dll")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-+".contains(&byte))
    {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    !["con", "prn", "aux", "nul"].contains(&stem.as_str())
        && !(stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit())
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn fixture(plus: bool) -> Vec<u8> {
        let mut data = vec![0; 1024];
        data[..2].copy_from_slice(b"MZ");
        data[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        data[0x80..0x84].copy_from_slice(b"PE\0\0");
        data[0x86..0x88].copy_from_slice(&1u16.to_le_bytes());
        let optional_size = if plus { 240u16 } else { 224u16 };
        data[0x94..0x96].copy_from_slice(&optional_size.to_le_bytes());
        let optional = 0x98;
        let magic = if plus { 0x20bu16 } else { 0x10bu16 };
        data[optional..optional + 2].copy_from_slice(&magic.to_le_bytes());
        data[optional + 60..optional + 64].copy_from_slice(&512u32.to_le_bytes());
        let count = if plus { 108 } else { 92 };
        let directory = if plus { 112 } else { 96 };
        data[optional + count..optional + count + 4].copy_from_slice(&16u32.to_le_bytes());
        data[optional + directory + 8..optional + directory + 12]
            .copy_from_slice(&0x1000u32.to_le_bytes());
        data[optional + directory + 12..optional + directory + 16]
            .copy_from_slice(&40u32.to_le_bytes());
        let section = optional + optional_size as usize;
        for (offset, value) in [(8, 512u32), (12, 0x1000), (16, 512), (20, 512)] {
            data[section + offset..section + offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        data[524..528].copy_from_slice(&0x1040u32.to_le_bytes());
        data[576..589].copy_from_slice(b"KERNEL32.dll\0");
        data
    }
    #[test]
    fn pe32_and_pe32plus_import_rvas_map_to_raw_file_offsets() {
        for plus in [false, true] {
            assert_eq!(
                static_imports(&fixture(plus)).unwrap(),
                vec!["kernel32.dll"]
            );
        }
    }
    #[test]
    fn malformed_imports_never_become_external_paths_or_unbounded_reads() {
        let data = fixture(true);
        for length in 0..data.len() {
            let _ = static_imports(&data[..length]);
        }
        let mut bad = data.clone();
        bad[0x3c..0x40].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(static_imports(&bad).is_err());
        let mut bad = data.clone();
        bad[524..528].copy_from_slice(&0xfffffff0u32.to_le_bytes());
        assert!(static_imports(&bad).is_err());
        let mut bad = data.clone();
        bad[576] = b'\\';
        assert!(static_imports(&bad).is_err());
        let mut bad = data.clone();
        bad[0x98 + 124..0x98 + 128].copy_from_slice(&20u32.to_le_bytes());
        assert!(static_imports(&bad).is_err());
        let mut bad = data;
        bad[576..832].fill(b'a');
        assert!(static_imports(&bad).is_err());
    }
}
