//! Luminance inversion for dark-mode page rendering.
//!
//! A naive RGB invert turns photographs into negatives and colour charts
//! unreadable. This flips *lightness only* — hue and saturation survive —
//! and the engine skips the pixels of embedded images entirely, so photos
//! stay positive.

/// An axis-aligned rectangle in device pixels, top-left origin. Used to
/// carve image objects out of the inversion.
#[derive(Debug, Clone, Copy)]
pub struct PixelRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl PixelRect {
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if max == min {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    } / 6.0;
    (h, s, l)
}

fn hue_component(p: f32, q: f32, mut t: f32) -> f32 {
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }
    if t < 1.0 / 6.0 {
        p + (q - p) * 6.0 * t
    } else if t < 1.0 / 2.0 {
        q
    } else if t < 2.0 / 3.0 {
        p + (q - p) * (2.0 / 3.0 - t) * 6.0
    } else {
        p
    }
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    if s == 0.0 {
        return (l, l, l);
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    (
        hue_component(p, q, h + 1.0 / 3.0),
        hue_component(p, q, h),
        hue_component(p, q, h - 1.0 / 3.0),
    )
}

/// Flips lightness, preserving hue and saturation. Pure; involutive to
/// within rounding error.
pub fn invert_pixel(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let (h, s, l) = rgb_to_hsl(
        f32::from(r) / 255.0,
        f32::from(g) / 255.0,
        f32::from(b) / 255.0,
    );
    let (r2, g2, b2) = hsl_to_rgb(h, s, 1.0 - l);
    (
        (r2 * 255.0).round() as u8,
        (g2 * 255.0).round() as u8,
        (b2 * 255.0).round() as u8,
    )
}

/// In-place lightness inversion of a tightly packed RGBA8 buffer, leaving
/// pixels inside any `skip` rect (device px, top-left origin, relative to
/// this buffer) untouched. Alpha is never modified.
// ponytail: per-pixel rect containment scan, O(pixels * rects). Rects per
// page = embedded images, almost always < 10; precompute per-row spans if a
// pathological document ever makes this visible in a profile.
pub fn invert_page(rgba: &mut [u8], width: u32, skip: &[PixelRect]) {
    if width == 0 {
        return;
    }
    let w = width as usize;
    for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
        let x = (i % w) as i32;
        let y = (i / w) as i32;
        if skip.iter().any(|r| r.contains(x, y)) {
            continue;
        }
        let (r, g, b) = invert_pixel(px[0], px[1], px[2]);
        px[0] = r;
        px[1] = g;
        px[2] = b;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hue_degrees(r: u8, g: u8, b: u8) -> f32 {
        let (h, _, _) = rgb_to_hsl(
            f32::from(r) / 255.0,
            f32::from(g) / 255.0,
            f32::from(b) / 255.0,
        );
        h * 360.0
    }

    #[test]
    fn white_and_black_swap() {
        assert_eq!(invert_pixel(255, 255, 255), (0, 0, 0));
        assert_eq!(invert_pixel(0, 0, 0), (255, 255, 255));
    }

    #[test]
    fn inversion_is_an_involution() {
        for &(r, g, b) in &[
            (12u8, 34u8, 56u8),
            (200, 180, 20),
            (255, 0, 0),
            (17, 255, 90),
            (128, 128, 128),
            (240, 240, 250),
        ] {
            let (r1, g1, b1) = invert_pixel(r, g, b);
            let (r2, g2, b2) = invert_pixel(r1, g1, b1);
            for (orig, twice) in [(r, r2), (g, g2), (b, b2)] {
                assert!(
                    (i16::from(orig) - i16::from(twice)).abs() <= 2,
                    "involution drifted: ({r},{g},{b}) -> ({r2},{g2},{b2})"
                );
            }
        }
    }

    #[test]
    fn saturated_red_keeps_its_hue() {
        let (r, g, b) = invert_pixel(255, 0, 0);
        let hue = hue_degrees(r, g, b);
        assert!(
            !(4.0..356.0).contains(&hue),
            "red hue drifted to {hue} degrees"
        );
        assert!(r > g && r > b, "red is no longer the dominant channel");
    }

    #[test]
    fn mid_grey_stays_mid_grey() {
        let (r, g, b) = invert_pixel(128, 128, 128);
        assert!(r.abs_diff(127) <= 1 && g.abs_diff(127) <= 1 && b.abs_diff(127) <= 1);
    }

    #[test]
    fn invert_page_honours_skip_rects_and_alpha() {
        // 4x2 white image; skip the left 2x2 block.
        let mut rgba = vec![255u8; 4 * 2 * 4];
        for px in rgba.chunks_exact_mut(4) {
            px[3] = 200; // distinctive alpha
        }
        let skip = [PixelRect {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
        }];
        invert_page(&mut rgba, 4, &skip);

        for y in 0..2 {
            for x in 0..4 {
                let i = (y * 4 + x) * 4;
                let expected = if x < 2 { 255 } else { 0 };
                assert_eq!(rgba[i], expected, "pixel ({x},{y}) wrong");
                assert_eq!(rgba[i + 3], 200, "alpha modified at ({x},{y})");
            }
        }
    }
}
