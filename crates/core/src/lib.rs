//! Pure Rust foundation for Tsumugi's project semantics.
//!
//! M01-T01 intentionally keeps this crate free of desktop, webview, and
//! persistence dependencies. Later lifecycle modules will add behavior here.

/// The product name shared by the desktop shell and Core package metadata.
pub const PRODUCT_NAME: &str = "Tsumugi";
