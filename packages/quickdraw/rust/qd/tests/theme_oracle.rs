//! Theme oracle against the public API. This file fails to compile if that
//! API is not exported. The assertions run once, from here.

use qd::theme::*;

include!("../src/theme/oracle_body.rs");
