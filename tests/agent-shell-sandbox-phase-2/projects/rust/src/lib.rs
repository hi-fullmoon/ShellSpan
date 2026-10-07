pub fn sum(values: &[i64]) -> i64 {
    values.iter().sum()
}

#[cfg(test)]
mod tests {
    use super::sum;

    #[test]
    fn sums_empty_and_signed_collections() {
        assert_eq!(sum(&[]), 0);
        assert_eq!(sum(&[3, -5, 8]), 6);
    }
}
