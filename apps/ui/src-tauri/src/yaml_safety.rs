//! YAML parse-time safety (B5 §6.5).
//!
//! Phase 2 ingests YAML from packets a contributor may have committed and a
//! reviewer pulls. The parser MUST cap input size, anchor count, and parse
//! time to prevent billion-laughs / quadratic-blowup DoS (CVE-2013-4660 family).
//!
//! Limits:
//!   - 10 MB input cap (typical packet 50-200 KB)
//!   - 100 anchors max (counted by pre-parse `&` / `*` scan)
//!   - 500 ms parse timeout (enforced at the call site by the saga's tokio task)
//!
//! Sprint 1 ships the size + anchor checks. Cycle-3 C3-S-SEC-4 wired both
//! gates into `saga::run_inner`'s packet-YAML read path (saga.rs:518-552),
//! so the module is live as of PR #29. The frontend is the secondary
//! defense — `eemeli/yaml` is invoked with `{ schema: 'core' }` over there.
//!
//! v0.1.x will add the parse-timeout gate (the third B5 §6.5 layer); the
//! tokio-task harness is already specified but not yet wired. `Timeout`
//! lives in `IpcError::YamlReason` as a wire-format placeholder so the TS
//! contract doesn't churn when the gate lands.

pub const MAX_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_ANCHORS: usize = 100;

#[derive(Debug, PartialEq, Eq)]
pub enum YamlSafetyError {
    SizeCap { actual: usize },
    AnchorCount { actual: usize },
}

pub fn check_size(input: &[u8]) -> Result<(), YamlSafetyError> {
    if input.len() > MAX_BYTES {
        Err(YamlSafetyError::SizeCap { actual: input.len() })
    } else {
        Ok(())
    }
}

pub fn check_anchor_count(input: &str) -> Result<(), YamlSafetyError> {
    let mut count = 0usize;
    for ch in input.chars() {
        if ch == '&' || ch == '*' {
            count += 1;
            if count > MAX_ANCHORS {
                return Err(YamlSafetyError::AnchorCount { actual: count });
            }
        }
    }
    Ok(())
}

/// v0.1.1 B7: combined size + anchor-count gate, applied at every YAML
/// parse site in the production code (saga read path, boot recovery,
/// pattern file load, watcher external-edit parse). The saga path had
/// this gate inline post-cycle-3 C3-S-SEC-4; extracting as a helper closes
/// the same anchor-bomb DoS surface on the three OTHER parse sites that
/// were inadvertently skipped (boot recovery and the patterns load can be
/// hit by a hostile YAML in any ancestor of cwd before Trail launches —
/// CWD-trust risk per security audit P3-6).
///
/// Returns `Err(...)` if the input violates either cap; the caller maps
/// to whichever domain-error variant fits (saga path uses
/// `SagaError::YamlSafety`; the watcher/boot paths can `.warn!` and skip
/// the file).
pub fn guard(input: &str) -> Result<(), YamlSafetyError> {
    check_size(input.as_bytes())?;
    check_anchor_count(input)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_small_input() {
        assert!(check_size(b"_meta: {}").is_ok());
    }

    #[test]
    fn rejects_oversize_input() {
        let buf = vec![b'a'; MAX_BYTES + 1];
        assert!(matches!(check_size(&buf), Err(YamlSafetyError::SizeCap { .. })));
    }

    #[test]
    fn accepts_modest_anchor_count() {
        let s = "& * &x &y *x".to_string();
        assert!(check_anchor_count(&s).is_ok());
    }

    #[test]
    fn rejects_billion_laughs_marker_density() {
        let s = "&".repeat(MAX_ANCHORS + 1);
        assert!(matches!(
            check_anchor_count(&s),
            Err(YamlSafetyError::AnchorCount { .. })
        ));
    }

    // Cycle-3 C3-V-TR-06: pin the boundary conditions for both checks.
    // Off-by-one drift (`>` vs `>=`) is the classic silent-regression
    // failure mode for cap checks — these tests catch any future refactor
    // that flips the comparison.

    #[test]
    fn accepts_input_exactly_at_size_cap() {
        let buf = vec![b'a'; MAX_BYTES];
        assert!(check_size(&buf).is_ok());
    }

    #[test]
    fn accepts_anchor_count_exactly_at_cap() {
        let s = "&".repeat(MAX_ANCHORS);
        assert!(check_anchor_count(&s).is_ok());
    }
}
