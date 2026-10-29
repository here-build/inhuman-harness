// TypeScript theme oracle. Included only from `tests/theme_oracle.rs`.

const JND: f64 = 0.074;
const HUE_FLOOR_DEG: f64 = 15.0;
const FG_LADDER: [(&str, f64); 5] = [
    ("whisper", FgP::WHISPER),
    ("ghost", FgP::GHOST),
    ("rising", FgP::RISING),
    ("secondary", FgP::SECONDARY),
    ("primary", FgP::PRIMARY),
];

fn theme_at(ground: f64) -> Theme {
    build_theme(&BuildThemeOpts {
        ground: Some(ground),
        ..BuildThemeOpts::default()
    })
}

fn ctx_at(theme: &Theme, depth: ColorDepth) -> ResolveCtx<'_> {
    ResolveCtx {
        theme,
        depth,
        region_prominence: None,
    }
}

fn tc(theme: &Theme) -> ResolveCtx<'_> {
    ctx_at(theme, ColorDepth::Truecolor)
}

fn role_at(role: Role, prominence: f64) -> StyleIntent {
    StyleIntent {
        role: Some(role),
        prominence: Some(prominence),
        ..StyleIntent::default()
    }
}

fn bg_at(role: Role, prominence: f64) -> StyleIntent {
    StyleIntent {
        bg_role: Some(role),
        bg_prominence: Some(prominence),
        ..StyleIntent::default()
    }
}

fn al_of(rgb: Rgb) -> f64 {
    let o = rgb_to_oklch(f64::from(rgb.r), f64::from(rgb.g), f64::from(rgb.b));
    apparent_lightness(o.l, o.c, o.h)
}

fn sum_rgb(rgb: Rgb) -> u16 {
    u16::from(rgb.r) + u16::from(rgb.g) + u16::from(rgb.b)
}

fn hue_delta(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 {
        360.0 - d
    } else {
        d
    }
}

fn wcag_y(rgb: Rgb) -> f64 {
    fn lin(x: u8) -> f64 {
        let ch = f64::from(x) / 255.0;
        if ch <= 0.04045 {
            ch / 12.92
        } else {
            ((ch + 0.055) / 1.055).powf(2.4)
        }
    }
    0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b)
}

fn lum(rgb: Rgb) -> f64 {
    0.2126 * f64::from(rgb.r) + 0.7152 * f64::from(rgb.g) + 0.0722 * f64::from(rgb.b)
}

fn assert_close(actual: f64, expected: f64, digits: i32) {
    let tol = 0.5 * 10f64.powi(-digits);
    assert!(
        (actual - expected).abs() < tol,
        "{actual} not close to {expected} (tol {tol})"
    );
}

fn fg_rgb(style: &StyleIntent, ctx: &ResolveCtx<'_>) -> Rgb {
    resolve_style(style, ctx)
        .fg_rgb
        .expect("truecolor foreground")
}

fn bg_rgb(style: &StyleIntent, ctx: &ResolveCtx<'_>) -> Rgb {
    resolve_style(style, ctx)
        .bg_rgb
        .expect("truecolor background")
}

#[test]
fn role_names_roundtrip() {
    for role in Role::ALL {
        assert_eq!(Role::parse(role.as_str()), Some(role));
        assert_eq!(
            role.index(),
            Role::ALL
                .iter()
                .position(|r| *r == role)
                .expect("role is in ALL")
        );
    }
    assert_eq!(Role::parse("nope"), None);
    assert_eq!(Role::parse("Foreground"), None);
    assert_eq!(ANSI16_ROLE[1], Role::Error);
    assert_eq!(ANSI16_ROLE[14], Role::Accent);
}

#[test]
fn hk_solver_fused() {
    let theme = theme_at(REFERENCE_GROUND);
    assert_eq!(default_theme().color(Role::Error), theme.color(Role::Error));
    assert_eq!(
        solve(Tier::Differentiate, 0.13, 57.0, SolveOpts::default()),
        "#bb6b25"
    );
    assert_eq!(
        solve(Tier::Alarm, 0.16, 25.0, SolveOpts::default()),
        "#af3434"
    );
    assert_eq!(
        solve(Tier::Anchor, 0.125, 77.0, SolveOpts::default()),
        "#f8bf66"
    );
    assert_eq!(
        solve(Tier::Differentiate, 0.075, 134.0, SolveOpts::default()),
        "#728e60"
    );
    assert_eq!(
        solve(Tier::Baseline, 0.0, 250.0, SolveOpts::default()),
        "#b4b4b4"
    );
    assert_eq!(
        (
            theme.color(Role::Warning),
            theme.color(Role::Error),
            theme.color(Role::Emphasis),
            theme.color(Role::Success),
            theme.color(Role::Auto),
            theme.color(Role::Attention),
        ),
        ("#fa9212", "#af3434", "#f8bf66", "#728e60", "#34c4db", "#d1d242")
    );

    let hue_samples = [0.0, 90.0, 180.0, 255.0, 300.0, 359.0].map(hue_factor);
    assert!(hue_samples.iter().all(|f| *f >= 0.5 && *f <= 1.0));
    assert!(hue_factor(300.0) > hue_factor(110.0));
    assert!(hue_factor(110.0) < hue_factor(30.0));
    assert_close(hue_factor(30.0), 0.8428, 3);

    assert!(apparent_lightness(0.7, 0.15, 255.0) > 0.7);
    assert_close(
        solve_lightness(apparent_lightness(0.62, 0.1, 57.0), 0.1, 57.0),
        0.62,
        10,
    );

    let dark = theme_at(0.2);
    let light = theme_at(0.95);
    assert!(hex_to_oklch(dark.color(Role::Foreground)).l > 0.2);
    assert!(hex_to_oklch(light.color(Role::Foreground)).l < 0.95);
    assert_ne!(dark.color(Role::Accent), light.color(Role::Accent));
    assert_eq!(
        [
            canvas_polarity(Some(0.2)),
            canvas_polarity(Some(0.8)),
            canvas_polarity(None)
        ],
        [
            CanvasPolarity::Dark,
            CanvasPolarity::Light,
            CanvasPolarity::Dark
        ]
    );

    let targets = Tier::ALL.map(|tier| tier_target(tier, 0.5, Polarity::Up));
    let mut sorted = targets;
    sorted.sort_by(|a, b| a.partial_cmp(b).expect("tier target is finite"));
    assert_eq!(targets, sorted);

    let gamut_hex = solve(
        Tier::Anchor,
        0.125,
        77.0,
        SolveOpts {
            ground: Some(0.98),
            polarity: Polarity::Auto,
        },
    );
    let gamut = hex_to_oklch(&gamut_hex);
    let emph = hex_to_oklch(theme_at(0.98).color(Role::Emphasis));
    assert!(gamut.h > 70.0 && gamut.h < 85.0, "solve hue {}", gamut.h);
    assert!(emph.h > 70.0 && emph.h < 85.0, "theme hue {}", emph.h);
    assert_ne!(gamut_hex.to_lowercase(), "#542400");

    assert!(ground_from_rgb(0.0, 0.0, 0.0) < 0.1);
    assert!(ground_from_rgb(255.0, 255.0, 255.0) > 0.9);
}

#[test]
fn contrast_floor_at_reference_grounds() {
    for ground in [0.1, 0.2, 0.9] {
        let theme = theme_at(ground);
        let ctx = tc(&theme);
        let als: Vec<(&str, f64)> = FG_LADDER
            .iter()
            .map(|(step, p)| (*step, al_of(fg_rgb(&role_at(Role::Foreground, *p), &ctx))))
            .collect();
        let mut gaps = Vec::new();
        for i in 1..als.len() {
            let delta = (als[i].1 - als[i - 1].1).abs();
            if delta < JND {
                gaps.push(format!("{}->{} {delta}", als[i - 1].0, als[i].0));
            }
        }
        assert!(gaps.is_empty(), "ground {ground}: {gaps:?}");

        let weak: Vec<Role> = Role::ALL
            .into_iter()
            .filter(|role| (al_of(fg_rgb(&role_at(*role, 1.0), &ctx)) - ground).abs() < JND)
            .collect();
        assert!(weak.is_empty(), "ground {ground}: {weak:?}");

        let panel = bg_rgb(&bg_at(Role::Surface, BgP::PANEL), &ctx);
        let wash = bg_rgb(&bg_at(Role::Surface, BgP::WASH), &ctx);
        let panel_y = wcag_y(panel);
        let wash_y = wcag_y(wash);
        let relative = (panel_y - wash_y).abs() / panel_y.min(wash_y).max(0.005);
        assert!(relative >= JND, "ground {ground} panel/wash {relative}");

        let code_al = al_of(fg_rgb(&role_at(Role::Code, 1.0), &ctx));
        let fg_al = al_of(fg_rgb(&role_at(Role::Foreground, 1.0), &ctx));
        assert!((code_al - fg_al).abs() < JND, "ground {ground} code/fg");

        let roles = [Role::Code, Role::Muted, Role::Foreground];
        let oklch: Vec<Oklch> = roles
            .iter()
            .map(|role| hex_to_oklch(theme.color(*role)))
            .collect();
        let mut muddled = Vec::new();
        for i in 0..roles.len() {
            for j in (i + 1)..roles.len() {
                let a = oklch[i];
                let b = oklch[j];
                let al_delta =
                    (apparent_lightness(a.l, a.c, a.h) - apparent_lightness(b.l, b.c, b.h)).abs();
                if !(al_delta >= JND || hue_delta(a.h, b.h) >= HUE_FLOOR_DEG) {
                    muddled.push(format!("{} vs {}", roles[i], roles[j]));
                }
            }
        }
        assert!(muddled.is_empty(), "ground {ground}: {muddled:?}");

        for role in [Role::Error, Role::DiffDel] {
            let plain = al_of(fg_rgb(&role_at(role, 1.0), &ctx));
            let bold = al_of(fg_rgb(
                &StyleIntent {
                    role: Some(role),
                    prominence: Some(1.0),
                    bold: true,
                    ..StyleIntent::default()
                },
                &ctx,
            ));
            assert!((bold - ground).abs() >= JND, "{role} jnd at {ground}");
            assert!(
                (bold - ground).abs() < (plain - ground).abs(),
                "{role} toward ground at {ground}"
            );
        }

        for (step, p) in [
            ("mist", BgP::MIST),
            ("wash", BgP::WASH),
            ("panel", BgP::PANEL),
        ] {
            let style = bg_at(Role::DiffAdd, p);
            let plain = bg_rgb(&style, &ctx);
            let selected = bg_rgb(
                &StyleIntent {
                    selected: true,
                    ..style
                },
                &ctx,
            );
            let delta = (al_of(selected) - al_of(plain)).abs();
            assert!(delta >= JND, "{step} at {ground} delta {delta}");
            assert!(
                (al_of(selected) - ground).abs() > (al_of(plain) - ground).abs(),
                "{step} at {ground} not away from ground"
            );
        }
        let mist = bg_rgb(&bg_at(Role::DiffAdd, BgP::MIST), &ctx);
        let wash_bg = bg_rgb(&bg_at(Role::DiffAdd, BgP::WASH), &ctx);
        assert!((al_of(mist) - ground).abs() < (al_of(wash_bg) - ground).abs());
        let mist_c = rgb_to_oklch(f64::from(mist.r), f64::from(mist.g), f64::from(mist.b)).c;
        let wash_c = rgb_to_oklch(
            f64::from(wash_bg.r),
            f64::from(wash_bg.g),
            f64::from(wash_bg.b),
        )
        .c;
        assert!(mist_c < wash_c, "ground {ground}");
    }
}

#[test]
fn depth_truecolor_field_shape() {
    let theme = theme_at(REFERENCE_GROUND);
    let ctx = tc(&theme);
    let fg = resolve_style(&role_at(Role::Error, 1.0), &ctx);
    let solid = resolve_style(&bg_at(Role::Surface, BgP::SOLID), &ctx);
    let wash = resolve_style(&bg_at(Role::Surface, BgP::WASH), &ctx);
    let unset = resolve_style(
        &StyleIntent {
            bg_role: Some(Role::Surface),
            ..StyleIntent::default()
        },
        &ctx,
    );
    assert_eq!(fg.fg, None);
    assert_eq!(fg.role, Some(Role::Error));
    assert!(fg.fg_rgb.is_some());
    assert!(solid.bg_rgb.is_some());
    assert!(sum_rgb(wash.bg_rgb.expect("wash")) < sum_rgb(solid.bg_rgb.expect("solid")));
    assert_ne!(solid.bg_rgb, wash.bg_rgb);
    assert_eq!(unset.bg_rgb, solid.bg_rgb);
    assert_eq!(
        make_style_resolver(ctx).resolve(&role_at(Role::Error, 1.0)),
        fg
    );
}

#[test]
fn depth_ansi256_field_shape() {
    let theme = theme_at(REFERENCE_GROUND);
    let error = resolve_style(
        &StyleIntent {
            role: Some(Role::Error),
            ..StyleIntent::default()
        },
        &ctx_at(&theme, ColorDepth::Ansi256),
    );
    let bg = resolve_style(
        &bg_at(Role::Surface, BgP::PANEL),
        &ctx_at(&theme, ColorDepth::Ansi256),
    );
    let nearest = u16::from(nearest_ansi256_from_rgb(theme.rgb(Role::Error)));
    assert_eq!(error.fg, Some(nearest));
    assert_eq!(error.fg_rgb, None);
    assert!(bg.bg.expect("bg index") >= 16);
    assert_eq!(bg.bg_rgb, None);
}

#[test]
fn depth_ansi16_field_shape() {
    let theme = theme_at(0.2);
    let ctx = ctx_at(&theme, ColorDepth::Ansi16);
    let error = resolve_style(&role_at(Role::Error, 1.0), &ctx);
    let muted = resolve_style(&role_at(Role::Muted, 0.4), &ctx);
    let accent = resolve_style(&role_at(Role::Accent, 1.0), &ctx);
    let lit = resolve_style(
        &StyleIntent {
            fg_rgb: Some(Rgb {
                r: 249,
                g: 40,
                b: 40,
            }),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let bg = resolve_style(
        &StyleIntent {
            bg_rgb: Some(Rgb {
                r: 20,
                g: 40,
                b: 20,
            }),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let both = resolve_style(
        &StyleIntent {
            fg_rgb: Some(Rgb {
                r: 0,
                g: 200,
                b: 80,
            }),
            bg_rgb: Some(Rgb {
                r: 10,
                g: 30,
                b: 10,
            }),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let bg_role = resolve_style(&bg_at(Role::Surface, BgP::SOLID), &ctx);
    assert_eq!(error.fg, Some(9));
    assert_eq!(error.fg_rgb, None);
    assert_eq!(muted.fg, Some(8));
    assert_eq!(muted.fg_rgb, None);
    assert_eq!(accent.fg, Some(14));
    assert_eq!(accent.fg_rgb, None);
    assert_eq!(ansi16_slot(Role::Error, CanvasPolarity::Dark, 1.0), 9);
    assert_eq!(ansi16_slot(Role::Error, CanvasPolarity::Dark, 0.5), 1);
    assert!((0..=15).contains(&lit.fg.expect("lit")));
    assert_eq!(lit.fg_rgb, None);
    assert!((0..=15).contains(&bg.bg.expect("bg")));
    assert_eq!(bg.bg_rgb, None);
    assert!((0..=15).contains(&both.fg.expect("both fg")));
    assert!((0..=15).contains(&both.bg.expect("both bg")));
    assert_eq!((both.fg_rgb, both.bg_rgb), (None, None));
    assert!((0..=15).contains(&bg_role.bg.expect("bg role")));
    assert_eq!(bg_role.bg_rgb, None);
}

#[test]
fn ansi16_light_slots_keep_hue() {
    assert_eq!(ansi16_slot(Role::Emphasis, CanvasPolarity::Light, 1.0), 0);
    assert_eq!(ansi16_slot(Role::Error, CanvasPolarity::Light, 0.5), 9);
    assert_eq!(ansi16_slot(Role::Accent, CanvasPolarity::Light, 1.0), 4);
    assert_eq!(ansi16_slot(Role::Surface, CanvasPolarity::Light, 1.0), 7);
    assert_eq!(
        ansi16_slot(Role::Error, CanvasPolarity::Dark, LOUD_THRESHOLD),
        9
    );
    assert_eq!(ansi16_slot(Role::Error, CanvasPolarity::Dark, 0.7999), 1);
}

#[test]
fn ansi256_nearest() {
    let white = nearest_ansi256(255, 255, 255);
    let black = nearest_ansi256(0, 0, 0);
    let w = ansi256_to_rgb(u16::from(white));
    let b = ansi256_to_rgb(u16::from(black));
    assert!((16..=255).contains(&white));
    assert!(sum_rgb(w) > 600);
    assert!(sum_rgb(b) < 40);
    assert_eq!(nearest_ansi256(255, 0, 0), 196);
}

#[test]
fn do_not_pre_resolve_double_fade() {
    let theme = theme_at(0.2);
    let ctx = tc(&theme);
    let once = resolve_style(
        &StyleIntent {
            role: Some(Role::Foreground),
            region_prominence: Some(0.4),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let twice = resolve_style(&once, &ctx);
    assert!(once.fg_rgb.is_some());
    assert_eq!(once.region_prominence, Some(0.4));
    assert!(sum_rgb(twice.fg_rgb.expect("twice")) < sum_rgb(once.fg_rgb.expect("once")));
}

#[test]
fn fg_rgb_plus_role_recasts_to_role_al() {
    let theme = theme_at(0.2);
    let ctx = tc(&theme);
    let syntax = Rgb {
        r: 249,
        g: 117,
        b: 131,
    };
    let claimed = resolve_style(
        &StyleIntent {
            fg_rgb: Some(syntax),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let recast = resolve_style(
        &StyleIntent {
            role: Some(Role::Code),
            fg_rgb: Some(syntax),
            prominence: Some(1.0),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let code = resolve_style(&role_at(Role::Code, 1.0), &ctx);
    let faded = resolve_style(
        &StyleIntent {
            role: Some(Role::Code),
            fg_rgb: Some(syntax),
            prominence: Some(FgP::SECONDARY),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let code_faded = resolve_style(&role_at(Role::Code, FgP::SECONDARY), &ctx);
    let tok_hue = rgb_to_oklch(
        f64::from(syntax.r),
        f64::from(syntax.g),
        f64::from(syntax.b),
    )
    .h;
    let recast_rgb = recast.fg_rgb.expect("recast");
    let recast_hue = rgb_to_oklch(
        f64::from(recast_rgb.r),
        f64::from(recast_rgb.g),
        f64::from(recast_rgb.b),
    )
    .h;
    assert_eq!(claimed.fg_rgb, Some(syntax));
    assert!(hue_delta(tok_hue, recast_hue) < HUE_FLOOR_DEG);
    assert!((al_of(recast_rgb) - al_of(code.fg_rgb.expect("code"))).abs() < JND);
    assert!(
        (al_of(faded.fg_rgb.expect("faded")) - al_of(code_faded.fg_rgb.expect("code faded"))).abs()
            < JND
    );
}

#[test]
fn selection_hue_preserve_fill_and_indexed_emit() {
    let ground = 0.2;
    let theme = theme_at(ground);
    let diff_red = Rgb {
        r: 0xff,
        g: 0x70,
        b: 0x70,
    };
    let out = selection_recolor_rgb(diff_red, ground, None);
    let d_hue = hue_delta(
        rgb_to_oklch(
            f64::from(diff_red.r),
            f64::from(diff_red.g),
            f64::from(diff_red.b),
        )
        .h,
        rgb_to_oklch(f64::from(out.r), f64::from(out.g), f64::from(out.b)).h,
    );
    let cell = Rgb {
        r: 0xc0,
        g: 0xc0,
        b: 0xc0,
    };
    let before = rgb_to_oklch(f64::from(cell.r), f64::from(cell.g), f64::from(cell.b));
    let shifted = selection_recolor_rgb(cell, ground, None);
    let after = rgb_to_oklch(
        f64::from(shifted.r),
        f64::from(shifted.g),
        f64::from(shifted.b),
    );
    let selected = resolve_style(
        &StyleIntent {
            fg_rgb: Some(diff_red),
            selected: true,
            ..StyleIntent::default()
        },
        &tc(&theme),
    );
    let bg = Rgb {
        r: 40,
        g: 20,
        b: 20,
    };
    let selected_bg = resolve_style(
        &StyleIntent {
            bg_rgb: Some(bg),
            selected: true,
            ..StyleIntent::default()
        },
        &tc(&theme),
    );
    let plain16 = resolve_style(
        &StyleIntent {
            role: Some(Role::Accent),
            ..StyleIntent::default()
        },
        &ctx_at(&theme, ColorDepth::Ansi16),
    );
    let selected16 = resolve_style(
        &StyleIntent {
            role: Some(Role::Accent),
            selected: true,
            ..StyleIntent::default()
        },
        &ctx_at(&theme, ColorDepth::Ansi16),
    );
    let plain256 = resolve_style(
        &StyleIntent {
            role: Some(Role::Foreground),
            ..StyleIntent::default()
        },
        &ctx_at(&theme, ColorDepth::Ansi256),
    );
    let selected256 = resolve_style(
        &StyleIntent {
            role: Some(Role::Foreground),
            selected: true,
            ..StyleIntent::default()
        },
        &ctx_at(&theme, ColorDepth::Ansi256),
    );
    assert!(d_hue < 1.0, "hue {d_hue}");
    assert!(
        apparent_lightness(after.l, after.c, after.h)
            > apparent_lightness(before.l, before.c, before.h)
    );
    assert_eq!(
        selection_recolor_rgb(
            Rgb {
                r: 100,
                g: 150,
                b: 200
            },
            0.2,
            Some(0.0)
        ),
        Rgb {
            r: 100,
            g: 150,
            b: 200
        }
    );
    assert!((0.08..=0.1).contains(&SELECTION_SHIFT));
    let red = selected.fg_rgb.expect("selected fg");
    assert!(red.r > red.b && red.r > red.g);
    let selected_bg_rgb = selected_bg.bg_rgb.expect("selected bg");
    assert_ne!(selected_bg_rgb, bg);
    assert!(selected16.fg.is_some() && selected16.bg.is_some());
    assert_eq!(plain16.bg, None);
    assert_eq!((selected16.fg_rgb, selected16.bg_rgb), (None, None));
    assert!(selected256.fg.is_some() && selected256.bg.is_some());
    assert_eq!(plain256.bg, None);
    assert_eq!((selected256.fg_rgb, selected256.bg_rgb), (None, None));
}

#[test]
fn ghost_dim_only_at_ansi16_authored_dim_dropped() {
    let theme = theme_at(0.2);
    let ghost = role_at(Role::Foreground, FgP::GHOST);
    assert_eq!(
        resolve_style(&ghost, &ctx_at(&theme, ColorDepth::Truecolor)).dim,
        None
    );
    assert_eq!(
        resolve_style(&ghost, &ctx_at(&theme, ColorDepth::Ansi256)).dim,
        None
    );
    assert_eq!(
        resolve_style(&ghost, &ctx_at(&theme, ColorDepth::Ansi16)).dim,
        Some(true)
    );
    assert_eq!(
        resolve_style(
            &role_at(Role::Foreground, FgP::WHISPER),
            &ctx_at(&theme, ColorDepth::Ansi16)
        )
        .dim,
        Some(true)
    );
    assert_eq!(
        resolve_style(
            &role_at(Role::Foreground, FgP::SECONDARY),
            &ctx_at(&theme, ColorDepth::Ansi16)
        )
        .dim,
        None
    );
    let authored = resolve_style(
        &StyleIntent {
            role: Some(Role::Foreground),
            prominence: Some(FgP::PRIMARY),
            dim: Some(true),
            ..StyleIntent::default()
        },
        &ctx_at(&theme, ColorDepth::Truecolor),
    );
    let literal = resolve_style(
        &StyleIntent {
            fg_rgb: Some(Rgb {
                r: 200,
                g: 100,
                b: 100,
            }),
            dim: Some(true),
            ..StyleIntent::default()
        },
        &ctx_at(&theme, ColorDepth::Truecolor),
    );
    assert_eq!(authored.dim, None);
    assert_eq!(literal.dim, Some(true));
}

#[test]
fn mono_zero_color_attributes_survive_ghost_dims() {
    let theme = theme_at(REFERENCE_GROUND);
    let ctx = ctx_at(&theme, ColorDepth::Mono);
    let role = resolve_style(&role_at(Role::Accent, 1.0), &ctx);
    let literal = resolve_style(
        &StyleIntent {
            fg_rgb: Some(Rgb {
                r: 249,
                g: 117,
                b: 131,
            }),
            bg_rgb: Some(Rgb {
                r: 20,
                g: 40,
                b: 20,
            }),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let bg_role = resolve_style(
        &bg_at(Role::Surface, BgP::SOLID),
        &ctx_at(&theme_at(0.2), ColorDepth::Mono),
    );
    let attrs = resolve_style(
        &StyleIntent {
            role: Some(Role::Foreground),
            bold: true,
            italic: true,
            strike: true,
            underline: true,
            ..StyleIntent::default()
        },
        &ctx,
    );
    let ghost = resolve_style(
        &role_at(Role::Foreground, FgP::GHOST),
        &ctx_at(&theme_at(0.2), ColorDepth::Mono),
    );
    let whisper = resolve_style(
        &role_at(Role::Foreground, FgP::WHISPER),
        &ctx_at(&theme_at(0.2), ColorDepth::Mono),
    );
    let secondary = resolve_style(
        &role_at(Role::Foreground, FgP::SECONDARY),
        &ctx_at(&theme_at(0.2), ColorDepth::Mono),
    );
    assert_eq!(
        (role.fg, role.fg_rgb, role.bg, role.bg_rgb),
        (None, None, None, None)
    );
    assert_eq!(
        (literal.fg, literal.fg_rgb, literal.bg, literal.bg_rgb),
        (None, None, None, None)
    );
    assert_eq!((bg_role.bg, bg_role.bg_rgb), (None, None));
    assert!(attrs.bold && attrs.italic && attrs.strike && attrs.underline);
    assert_eq!(
        (attrs.fg, attrs.fg_rgb, attrs.bg, attrs.bg_rgb),
        (None, None, None, None)
    );
    assert_eq!(ghost.dim, Some(true));
    assert_eq!(whisper.dim, Some(true));
    assert_eq!(secondary.dim, None);
    assert_eq!(
        (ghost.fg, ghost.fg_rgb, ghost.bg, ghost.bg_rgb),
        (None, None, None, None)
    );
}

#[test]
fn bold_toward_ground_both_polarities_fg_only_then_selection_once() {
    let dark = theme_at(0.2);
    let light = theme_at(0.85);
    let plain_dark = fg_rgb(&role_at(Role::Foreground, 1.0), &tc(&dark));
    let bold_dark = fg_rgb(
        &StyleIntent {
            role: Some(Role::Foreground),
            prominence: Some(1.0),
            bold: true,
            ..StyleIntent::default()
        },
        &tc(&dark),
    );
    let plain_light = fg_rgb(&role_at(Role::Foreground, 1.0), &tc(&light));
    let bold_light = fg_rgb(
        &StyleIntent {
            role: Some(Role::Foreground),
            prominence: Some(1.0),
            bold: true,
            ..StyleIntent::default()
        },
        &tc(&light),
    );
    let panel = StyleIntent {
        role: Some(Role::Error),
        bg_role: Some(Role::Surface),
        bg_prominence: Some(BgP::PANEL),
        ..StyleIntent::default()
    };
    let plain_panel = resolve_style(&panel, &tc(&dark));
    let bold_panel = resolve_style(
        &StyleIntent {
            bold: true,
            ..panel
        },
        &tc(&dark),
    );
    let bg_lit = Rgb {
        r: 40,
        g: 40,
        b: 48,
    };
    let bold_lit = resolve_style(
        &StyleIntent {
            bg_rgb: Some(bg_lit),
            bold: true,
            ..StyleIntent::default()
        },
        &tc(&dark),
    );
    let bold_only = resolve_style(
        &StyleIntent {
            role: Some(Role::Accent),
            bold: true,
            ..StyleIntent::default()
        },
        &tc(&dark),
    );
    let bold_selected = resolve_style(
        &StyleIntent {
            role: Some(Role::Accent),
            bold: true,
            selected: true,
            ..StyleIntent::default()
        },
        &tc(&dark),
    );
    assert!(sum_rgb(bold_dark) < sum_rgb(plain_dark));
    assert!(sum_rgb(bold_light) > sum_rgb(plain_light));
    assert_eq!(bold_panel.bg_rgb, plain_panel.bg_rgb);
    assert_ne!(bold_panel.fg_rgb, plain_panel.fg_rgb);
    assert_eq!(bold_lit.bg_rgb, Some(bg_lit));
    assert_eq!(
        bold_selected.fg_rgb,
        Some(selection_recolor_rgb(
            bold_only.fg_rgb.expect("bold"),
            dark.ground(),
            None
        ))
    );
}

#[test]
fn fg_prominence_dissolves_toward_local_surface() {
    let theme = theme_at(0.2);
    let ctx = tc(&theme);
    let surface = bg_rgb(&bg_at(Role::Surface, BgP::PANEL), &ctx);
    let on_panel = fg_rgb(
        &StyleIntent {
            role: Some(Role::Muted),
            prominence: Some(0.05),
            surface_role: Some(Role::Surface),
            surface_prominence: Some(BgP::PANEL),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let on_ground = fg_rgb(
        &StyleIntent {
            role: Some(Role::Muted),
            prominence: Some(0.05),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let with_bg = fg_rgb(
        &StyleIntent {
            role: Some(Role::Muted),
            prominence: Some(0.08),
            bg_role: Some(Role::Surface),
            bg_prominence: Some(BgP::PANEL),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let via_surface = fg_rgb(
        &StyleIntent {
            role: Some(Role::Muted),
            prominence: Some(0.08),
            surface_role: Some(Role::Surface),
            surface_prominence: Some(BgP::PANEL),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let d_panel = (i32::from(sum_rgb(on_panel)) - i32::from(sum_rgb(surface))).abs();
    let d_ground = (i32::from(sum_rgb(on_ground)) - i32::from(sum_rgb(surface))).abs();
    assert!(d_panel < d_ground, "panel {d_panel} ground {d_ground}");
    assert_eq!(with_bg, via_surface);
}

#[test]
fn transparent_fg_at_zero_matches_probed_ground() {
    let ground_rgb = Rgb {
        r: 28,
        g: 24,
        b: 20,
    };
    let theme = build_theme(&BuildThemeOpts {
        ground_rgb: Some(ground_rgb),
        ..BuildThemeOpts::default()
    });
    let gone = resolve_style(
        &StyleIntent {
            role: Some(Role::Muted),
            prominence: Some(0.0),
            ..StyleIntent::default()
        },
        &tc(&theme),
    );
    assert_eq!(gone.fg_rgb, Some(theme.ground_rgb()));
}

#[test]
fn region_times_bg_independent_fuse_quadratic_dechroma() {
    let theme = theme_at(0.2);
    let ctx = tc(&theme);
    let full = resolve_style(
        &StyleIntent {
            role: Some(Role::Foreground),
            bg_role: Some(Role::Surface),
            bg_prominence: Some(BgP::SOLID),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let bg_faded = resolve_style(
        &StyleIntent {
            role: Some(Role::Foreground),
            bg_role: Some(Role::Surface),
            bg_prominence: Some(BgP::WASH),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let region_dimmed = resolve_style(
        &StyleIntent {
            role: Some(Role::Foreground),
            bg_role: Some(Role::Surface),
            bg_prominence: Some(BgP::SOLID),
            region_prominence: Some(0.45),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let bg_only = resolve_style(&bg_at(Role::Surface, 0.5), &ctx);
    let region_only = resolve_style(
        &StyleIntent {
            bg_role: Some(Role::Surface),
            bg_prominence: Some(1.0),
            region_prominence: Some(0.5),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let both = resolve_style(
        &StyleIntent {
            bg_role: Some(Role::Surface),
            bg_prominence: Some(0.5),
            region_prominence: Some(1.0),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let bg = Rgb {
        r: 40,
        g: 60,
        b: 40,
    };
    let low_fg = resolve_style(
        &StyleIntent {
            prominence: Some(0.2),
            bg_rgb: Some(bg),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let full_fg = resolve_style(
        &StyleIntent {
            prominence: Some(1.0),
            bg_rgb: Some(bg),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let contour = resolve_style(&role_at(Role::Foreground, FgP::GHOST), &ctx);
    let fused0 = resolve_style(
        &StyleIntent {
            role: Some(Role::Warning),
            prominence: Some(0.0),
            fuse_role: Some(Role::Foreground),
            fuse_prominence: Some(FgP::GHOST),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let live = resolve_style(&role_at(Role::Warning, 1.0), &ctx);
    let mid = resolve_style(
        &StyleIntent {
            role: Some(Role::Warning),
            prominence: Some(0.6),
            fuse_role: Some(Role::Foreground),
            fuse_prominence: Some(FgP::GHOST),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let chroma = |rgb: Rgb| rgb_to_oklch(f64::from(rgb.r), f64::from(rgb.g), f64::from(rgb.b)).c;
    assert_eq!(bg_faded.fg_rgb, full.fg_rgb);
    assert_ne!(bg_faded.bg_rgb, full.bg_rgb);
    assert_ne!(region_dimmed.fg_rgb, full.fg_rgb);
    assert_ne!(region_dimmed.bg_rgb, full.bg_rgb);
    assert_eq!(bg_only.bg_rgb, region_only.bg_rgb);
    assert_eq!(both.bg_rgb, bg_only.bg_rgb);
    assert_eq!(low_fg.bg_rgb, full_fg.bg_rgb);
    assert_eq!(fused0.fg_rgb, contour.fg_rgb);
    let mid_rgb = mid.fg_rgb.expect("mid");
    let contour_rgb = contour.fg_rgb.expect("contour");
    let live_rgb = live.fg_rgb.expect("live");
    assert!(chroma(mid_rgb) < (chroma(contour_rgb) + chroma(live_rgb)) / 2.0);
}

#[test]
fn progress_fuse_under_region_dim_lands_on_dimmed_contour() {
    let theme = theme_at(0.2);
    let ctx = tc(&theme);
    let dim_contour = resolve_style(
        &StyleIntent {
            role: Some(Role::Foreground),
            prominence: Some(FgP::GHOST),
            region_prominence: Some(0.4),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let fuse = StyleIntent {
        role: Some(Role::Foreground),
        fuse_role: Some(Role::Foreground),
        fuse_prominence: Some(FgP::GHOST),
        tint_role: Some(Role::Warning),
        tint: Some(0.5),
        ..StyleIntent::default()
    };
    let fused0 = resolve_style(
        &StyleIntent {
            prominence: Some(0.0),
            region_prominence: Some(0.4),
            ..fuse.clone()
        },
        &ctx,
    );
    let hot = resolve_style(
        &StyleIntent {
            prominence: Some(1.0),
            ..fuse.clone()
        },
        &ctx,
    );
    let hot_dim = resolve_style(
        &StyleIntent {
            prominence: Some(1.0),
            region_prominence: Some(0.4),
            ..fuse
        },
        &ctx,
    );
    assert_eq!(fused0.fg_rgb, dim_contour.fg_rgb);
    assert!(lum(hot.fg_rgb.expect("hot")) > lum(hot_dim.fg_rgb.expect("hot dim")));
}

#[test]
fn tint_role_warms_chroma_toward_warning() {
    let theme = theme_at(REFERENCE_GROUND);
    let ctx = tc(&theme);
    let muted = fg_rgb(&role_at(Role::Muted, 1.0), &ctx);
    let warning = fg_rgb(&role_at(Role::Warning, 1.0), &ctx);
    let mid = fg_rgb(
        &StyleIntent {
            role: Some(Role::Muted),
            prominence: Some(1.0),
            tint_role: Some(Role::Warning),
            tint: Some(0.5),
            ..StyleIntent::default()
        },
        &ctx,
    );
    let chroma = |rgb: Rgb| rgb_to_oklch(f64::from(rgb.r), f64::from(rgb.g), f64::from(rgb.b)).c;
    let hue = |rgb: Rgb| rgb_to_oklch(f64::from(rgb.r), f64::from(rgb.g), f64::from(rgb.b)).h;
    assert!(chroma(mid) > chroma(muted));
    assert!(chroma(mid) < chroma(warning));
    assert!((hue(mid) - hue(warning)).abs() < 1.0);
}

#[test]
fn attune_dark_to_light_flips_wash_and_fuse() {
    let wash = bg_at(Role::DiffAdd, BgP::PANEL);
    let dark_theme = theme_at(0.2);
    let light_theme = theme_at(0.85);
    assert!(al_of(bg_rgb(&wash, &tc(&dark_theme))) > 0.2);
    assert!(al_of(bg_rgb(&wash, &tc(&light_theme))) < 0.85);

    let fused = StyleIntent {
        role: Some(Role::Foreground),
        prominence: Some(0.0),
        fuse_role: Some(Role::Foreground),
        fuse_prominence: Some(FgP::GHOST),
        ..StyleIntent::default()
    };
    let loud = StyleIntent {
        prominence: Some(1.0),
        ..fused.clone()
    };
    let dark_fused = al_of(fg_rgb(&fused, &tc(&dark_theme)));
    let dark_loud = al_of(fg_rgb(&loud, &tc(&dark_theme)));
    let light_fused = al_of(fg_rgb(&fused, &tc(&light_theme)));
    let light_loud = al_of(fg_rgb(&loud, &tc(&light_theme)));
    assert!(dark_loud > dark_fused);
    assert!(light_loud < light_fused);
}

#[test]
fn procedural_bg_fx_and_link_pass_through() {
    let theme = theme_at(REFERENCE_GROUND);
    let style = StyleIntent {
        role: Some(Role::Foreground),
        href: Some("https://example.com".to_owned()),
        bg_fx: Some("wash".to_owned()),
        bg_fx_u: Some(0.25),
        bg_fx_v: Some(0.5),
        cast_transparent: true,
        ..StyleIntent::default()
    };
    let out = resolve_style(&style, &tc(&theme));
    assert_eq!(out.href.as_deref(), Some("https://example.com"));
    assert_eq!(out.bg_fx.as_deref(), Some("wash"));
    assert_eq!(out.bg_fx_u, Some(0.25));
    assert_eq!(out.bg_fx_v, Some(0.5));
    assert!(out.cast_transparent);
    assert!(out.fg_rgb.is_some());
}

#[test]
fn indexed_color_passes_through_until_selection() {
    let theme = theme_at(0.2);
    let plain = resolve_style(
        &StyleIntent {
            fg: Some(12),
            bg: Some(4),
            ..StyleIntent::default()
        },
        &tc(&theme),
    );
    assert_eq!(
        (plain.fg, plain.bg, plain.fg_rgb, plain.bg_rgb),
        (Some(12), Some(4), None, None)
    );
    let selected = resolve_style(
        &StyleIntent {
            fg: Some(12),
            bg: Some(4),
            selected: true,
            ..StyleIntent::default()
        },
        &tc(&theme),
    );
    assert!(selected.fg_rgb.is_some() && selected.bg_rgb.is_some());
    assert_eq!((selected.fg, selected.bg), (None, None));
}
