const HASH_MODULUS: u32 = 647;

fn finalize_hash(mut acc: u32) -> u32 {
    acc ^= acc >> 15;
    acc = acc.wrapping_mul(0x85eb_ca6b);
    acc ^= acc >> 13;
    acc = acc.wrapping_mul(0xc2b2_ae35);
    acc ^= acc >> 16;
    acc % HASH_MODULUS
}

pub fn compute_line_hash(line: &str) -> u32 {
    let bytes = line.as_bytes();
    if bytes.is_empty() {
        return 0;
    }

    let mut acc: u32 = 0x9e37_79b1;
    if bytes.len() == 1 {
        acc ^= bytes[0] as u32;
        return finalize_hash(acc);
    }

    for window in bytes.windows(2) {
        let pair = ((window[0] as u32) << 8) | window[1] as u32;
        acc = acc.rotate_left(5) ^ pair.wrapping_mul(0x45d9_f3b);
    }
    finalize_hash(acc ^ (bytes.len() as u32))
}

pub fn verify_anchor(line: &str, expected: u32) -> bool {
    compute_line_hash(line) == expected
}

pub fn compute_line_hashes(lines: &[String]) -> Vec<u32> {
    lines.iter().map(|line| compute_line_hash(line)).collect()
}
