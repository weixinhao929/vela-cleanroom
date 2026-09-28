//! palette：图像取色公共管线（§4.3 封面取色 / §4.4 壁纸跟随主题共用）。
//!
//! 纯函数、无平台依赖：输入任意 `image::DynamicImage`，输出主色 / 次色 /
//! 中性色候选。壁纸跟随主题（wallpaper.rs）是首个消费者；媒体封面取色
//! （media.rs）合入时直接调用 [`extract_palette`]，不必再抄一份量化与打分。
//!
//! 管线设计（色彩学常量与量化策略属通用技术，规格见工作区对标分析 §4.3）：
//!  1. 缩到 ≤112×112——只要色彩分布，细节无关；
//!  2. RGB555 量化直方图（每通道 5bit，32³ 桶），每桶累计真实通道均值作代表色
//!     （桶中心色会系统性偏离实际像素）；
//!  3. sRGB → Oklab → 彩度 / 色相；
//!  4. 过滤近灰（chroma < 0.028）与过黑过白（L ∉ [0.12, 0.94]）；
//!  5. 打分 √占比×70 + 彩度×34 + 中亮度×10，占比 <1% 的稀有桶 ×0.65；
//!  6. primary = 最高分；secondary = 与 primary 色相差 ≥30° 的次高分；
//!     neutral = 全图像素均值（整体基调，供背景派生）。
//!
//! 全部候选被过滤掉（灰度图 / 纯黑白）时 primary 退回均值色，secondary 为空。
//! 本模块不做「L 钳制 / 明暗映射」——那是消费方按场景决定的事（壁纸主题在
//! 前端 wallpaper-theme.ts 按明暗两档分别调 L；封面取色钳 0.62–0.78）。

use std::cmp::Ordering;
use std::collections::HashMap;

use image::DynamicImage;

/// 8bit sRGB 三元组（取色输出）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb8 {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb8 {
    /// `#rrggbb` 小写十六进制。
    pub fn hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }
}

/// Oklab 坐标：L 感知亮度 0..1，a / b 对立色轴。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Oklab {
    pub l: f64,
    pub a: f64,
    pub b: f64,
}

impl Oklab {
    /// 彩度（Oklch 的 C）。
    pub fn chroma(self) -> f64 {
        (self.a * self.a + self.b * self.b).sqrt()
    }

    /// 色相角（度，[0, 360)）。近灰时数值无意义，调用方需先查 [`Self::chroma`]。
    pub fn hue_deg(self) -> f64 {
        let h = self.b.atan2(self.a).to_degrees();
        if h < 0.0 {
            h + 360.0
        } else {
            h
        }
    }
}

fn srgb_to_linear(c: u8) -> f64 {
    let v = c as f64 / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

#[cfg(test)]
fn linear_to_srgb(v: f64) -> u8 {
    let v = v.clamp(0.0, 1.0);
    let s = if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    };
    (s * 255.0).round().clamp(0.0, 255.0) as u8
}

/// sRGB → Oklab（Björn Ottosson 参考实现的系数）。
pub fn rgb_to_oklab(c: Rgb8) -> Oklab {
    let r = srgb_to_linear(c.r);
    let g = srgb_to_linear(c.g);
    let b = srgb_to_linear(c.b);
    let l = 0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b;
    let m = 0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b;
    let s = 0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b;
    let l_ = l.cbrt();
    let m_ = m.cbrt();
    let s_ = s.cbrt();
    Oklab {
        l: 0.210_454_255_3 * l_ + 0.793_617_785_0 * m_ - 0.004_072_046_8 * s_,
        a: 1.977_998_495_1 * l_ - 2.428_592_205_0 * m_ + 0.450_593_709_9 * s_,
        b: 0.025_904_037_1 * l_ + 0.782_771_766_2 * m_ - 0.808_675_766_0 * s_,
    }
}

/// Oklab → sRGB（越界通道钳到 [0, 255]）。目前只用于单测验证正变换的往返精度；
/// 消费方需要在 Rust 侧做 L 钳制（如封面取色的 0.62–0.78）时去掉 cfg 即可。
#[cfg(test)]
pub fn oklab_to_rgb(c: Oklab) -> Rgb8 {
    let l_ = c.l + 0.396_337_777_4 * c.a + 0.215_803_757_3 * c.b;
    let m_ = c.l - 0.105_561_345_8 * c.a - 0.063_854_172_8 * c.b;
    let s_ = c.l - 0.089_484_177_5 * c.a - 1.291_485_548_0 * c.b;
    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;
    Rgb8 {
        r: linear_to_srgb(4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s),
        g: linear_to_srgb(-1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s),
        b: linear_to_srgb(-0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701_0 * s),
    }
}

/// 取色结果：主色 / 次色（可能缺失）/ 中性基调色。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtractedPalette {
    pub primary: Rgb8,
    pub secondary: Option<Rgb8>,
    pub neutral: Rgb8,
}

/// 量化桶：像素计数 + 通道累加（均值代表色）。
#[derive(Default, Clone, Copy)]
struct Bucket {
    count: u32,
    r: u64,
    g: u64,
    b: u64,
}

impl Bucket {
    fn mean(&self) -> Rgb8 {
        let n = self.count.max(1) as u64;
        Rgb8 {
            r: (self.r / n) as u8,
            g: (self.g / n) as u8,
            b: (self.b / n) as u8,
        }
    }
}

struct Candidate {
    color: Rgb8,
    hue: f64,
    score: f64,
}

/// 缩略边长：112——分布统计对分辨率不敏感，封面与壁纸共用。
const THUMB: u32 = 112;
/// 近灰阈值（Oklab 彩度）。
const MIN_CHROMA: f64 = 0.028;
/// 可用亮度区间：过黑过白的桶不参与竞选（它们是阴影 / 高光，不是"颜色"）。
const L_RANGE: (f64, f64) = (0.12, 0.94);
/// 占比低于此值视为稀有桶，打分 ×0.65（防止小面积高饱和噪点夺冠）。
const RARE_SHARE: f64 = 0.01;
/// 次色与主色的最小色相距离（度）：更近的只是主色的明暗变体。
const SECONDARY_MIN_HUE_DIFF: f64 = 30.0;
/// 无像素可用时的兜底中性灰。
const FALLBACK_GRAY: Rgb8 = Rgb8 {
    r: 128,
    g: 128,
    b: 128,
};

/// 环形色相差（度，[0, 180]）。
fn hue_diff(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 {
        360.0 - d
    } else {
        d
    }
}

/// 从图像提取主色 / 次色 / 中性色（见模块文档的算法说明）。
///
/// 输入任意尺寸；内部缩略到 ≤112×112。alpha < 128 的像素视为透明跳过。
/// 结果确定性：桶按分数降序、同分按颜色十六进制字典序排序。
pub fn extract_palette(img: &DynamicImage) -> ExtractedPalette {
    let small = if img.width() > THUMB || img.height() > THUMB {
        img.thumbnail(THUMB, THUMB)
    } else {
        img.clone()
    };
    let rgba = small.to_rgba8();

    let mut buckets: HashMap<u16, Bucket> = HashMap::new();
    let (mut sum_r, mut sum_g, mut sum_b, mut n) = (0u64, 0u64, 0u64, 0u64);
    for px in rgba.pixels() {
        let [r, g, b, a] = px.0;
        if a < 128 {
            continue;
        }
        n += 1;
        sum_r += r as u64;
        sum_g += g as u64;
        sum_b += b as u64;
        let key = ((r as u16 >> 3) << 10) | ((g as u16 >> 3) << 5) | (b as u16 >> 3);
        let e = buckets.entry(key).or_default();
        e.count += 1;
        e.r += r as u64;
        e.g += g as u64;
        e.b += b as u64;
    }
    if n == 0 {
        return ExtractedPalette {
            primary: FALLBACK_GRAY,
            secondary: None,
            neutral: FALLBACK_GRAY,
        };
    }
    let neutral = Rgb8 {
        r: (sum_r / n) as u8,
        g: (sum_g / n) as u8,
        b: (sum_b / n) as u8,
    };

    let mut cands: Vec<Candidate> = buckets
        .values()
        .filter_map(|bk| {
            let color = bk.mean();
            let lab = rgb_to_oklab(color);
            let chroma = lab.chroma();
            if chroma < MIN_CHROMA || lab.l < L_RANGE.0 || lab.l > L_RANGE.1 {
                return None;
            }
            let share = bk.count as f64 / n as f64;
            let mid = (1.0 - (lab.l - 0.55).abs() / 0.45).clamp(0.0, 1.0);
            let mut score = share.sqrt() * 70.0 + chroma * 34.0 + mid * 10.0;
            if share < RARE_SHARE {
                score *= 0.65;
            }
            Some(Candidate {
                color,
                hue: lab.hue_deg(),
                score,
            })
        })
        .collect();
    cands.sort_by(|x, y| {
        y.score
            .partial_cmp(&x.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| x.color.hex().cmp(&y.color.hex()))
    });

    let Some(first) = cands.first() else {
        return ExtractedPalette {
            primary: neutral,
            secondary: None,
            neutral,
        };
    };
    let primary = first.color;
    let primary_hue = first.hue;
    let secondary = cands
        .iter()
        .skip(1)
        .find(|c| hue_diff(c.hue, primary_hue) >= SECONDARY_MIN_HUE_DIFF)
        .map(|c| c.color);
    ExtractedPalette {
        primary,
        secondary,
        neutral,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn solid(w: u32, h: u32, c: [u8; 4]) -> DynamicImage {
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(w, h, Rgba(c)))
    }

    #[test]
    fn oklab_roundtrip_is_lossless_within_one_step() {
        for &c in &[
            Rgb8 { r: 0, g: 0, b: 0 },
            Rgb8 {
                r: 255,
                g: 255,
                b: 255,
            },
            Rgb8 {
                r: 216,
                g: 48,
                b: 48,
            },
            Rgb8 {
                r: 30,
                g: 120,
                b: 220,
            },
            Rgb8 {
                r: 128,
                g: 128,
                b: 128,
            },
        ] {
            let back = oklab_to_rgb(rgb_to_oklab(c));
            assert!((back.r as i32 - c.r as i32).abs() <= 1, "{c:?} → {back:?}");
            assert!((back.g as i32 - c.g as i32).abs() <= 1, "{c:?} → {back:?}");
            assert!((back.b as i32 - c.b as i32).abs() <= 1, "{c:?} → {back:?}");
        }
        // 白的 L≈1、黑的 L≈0，灰的彩度≈0。
        assert!(
            rgb_to_oklab(Rgb8 {
                r: 255,
                g: 255,
                b: 255
            })
            .l > 0.99
        );
        assert!(rgb_to_oklab(Rgb8 { r: 0, g: 0, b: 0 }).l < 0.01);
        assert!(
            rgb_to_oklab(Rgb8 {
                r: 128,
                g: 128,
                b: 128
            })
            .chroma()
                < 1e-6
        );
    }

    #[test]
    fn solid_red_yields_red_primary_without_secondary() {
        let p = extract_palette(&solid(300, 200, [216, 48, 48, 255]));
        assert_eq!(
            p.primary,
            Rgb8 {
                r: 216,
                g: 48,
                b: 48
            }
        );
        assert_eq!(
            p.neutral,
            Rgb8 {
                r: 216,
                g: 48,
                b: 48
            }
        );
        assert!(p.secondary.is_none(), "单色图不应产生次色");
        let hue = rgb_to_oklab(p.primary).hue_deg();
        assert!((15.0..45.0).contains(&hue), "红色色相应在 ~30°，实际 {hue}");
    }

    #[test]
    fn two_hues_yield_distinct_secondary_and_dominant_primary() {
        // 左 70% 蓝、右 30% 橙：蓝占比更大应为主色，橙为次色（色相差远超 30°）。
        let mut img = RgbaImage::new(100, 40);
        for (x, _, px) in img.enumerate_pixels_mut() {
            *px = if x < 70 {
                Rgba([30, 110, 220, 255])
            } else {
                Rgba([235, 140, 30, 255])
            };
        }
        let p = extract_palette(&DynamicImage::ImageRgba8(img));
        assert_eq!(
            p.primary,
            Rgb8 {
                r: 30,
                g: 110,
                b: 220
            }
        );
        let sec = p.secondary.expect("双色图应有次色");
        assert_eq!(
            sec,
            Rgb8 {
                r: 235,
                g: 140,
                b: 30
            }
        );
        let d = hue_diff(
            rgb_to_oklab(p.primary).hue_deg(),
            rgb_to_oklab(sec).hue_deg(),
        );
        assert!(d >= SECONDARY_MIN_HUE_DIFF);
        // 中性色 = 全图均值，介于两色之间。
        assert!(p.neutral.r > 30 && p.neutral.r < 235);
    }

    #[test]
    fn near_hue_variants_do_not_count_as_secondary() {
        // 两种蓝（色相相近、明暗不同）：不应把明暗变体当次色。
        let mut img = RgbaImage::new(100, 40);
        for (x, _, px) in img.enumerate_pixels_mut() {
            *px = if x < 60 {
                Rgba([30, 110, 220, 255])
            } else {
                Rgba([90, 150, 235, 255])
            };
        }
        let p = extract_palette(&DynamicImage::ImageRgba8(img));
        assert!(
            p.secondary.is_none(),
            "明暗变体不应成为次色: {:?}",
            p.secondary
        );
    }

    #[test]
    fn grayscale_image_falls_back_to_mean() {
        let mut img = RgbaImage::new(64, 64);
        for (x, _, px) in img.enumerate_pixels_mut() {
            let v = (x * 4) as u8;
            *px = Rgba([v, v, v, 255]);
        }
        let p = extract_palette(&DynamicImage::ImageRgba8(img));
        assert!(p.secondary.is_none());
        // 全部桶因近灰被滤掉，primary 退回均值（≈126）。
        assert_eq!(p.primary, p.neutral);
        assert!((p.neutral.r as i32 - 126).abs() <= 2, "{:?}", p.neutral);
        assert_eq!(p.neutral.r, p.neutral.g);
        assert_eq!(p.neutral.g, p.neutral.b);
    }

    #[test]
    fn transparent_pixels_are_ignored_and_empty_image_is_safe() {
        // 全透明：无有效像素 → 兜底灰。
        let p = extract_palette(&solid(10, 10, [255, 0, 0, 0]));
        assert_eq!(p.primary, FALLBACK_GRAY);
        assert_eq!(p.neutral, FALLBACK_GRAY);
        assert!(p.secondary.is_none());
        // 0×0 图像不崩。
        let empty = DynamicImage::ImageRgba8(RgbaImage::new(0, 0));
        assert_eq!(extract_palette(&empty).primary, FALLBACK_GRAY);
        // 半透明遮罩下只有不透明的绿色参与统计。
        let mut img = RgbaImage::new(20, 20);
        for (x, _, px) in img.enumerate_pixels_mut() {
            *px = if x < 10 {
                Rgba([200, 30, 30, 40])
            } else {
                Rgba([40, 180, 90, 255])
            };
        }
        let p = extract_palette(&DynamicImage::ImageRgba8(img));
        assert_eq!(
            p.primary,
            Rgb8 {
                r: 40,
                g: 180,
                b: 90
            }
        );
        assert_eq!(
            p.neutral,
            Rgb8 {
                r: 40,
                g: 180,
                b: 90
            }
        );
    }

    #[test]
    fn large_image_is_downscaled_deterministically() {
        // 大图两次取色结果一致（HashMap 顺序不影响排序结果）。
        let a = extract_palette(&solid(1920, 1080, [120, 60, 200, 255]));
        let b = extract_palette(&solid(1920, 1080, [120, 60, 200, 255]));
        assert_eq!(a, b);
        assert_eq!(
            a.primary,
            Rgb8 {
                r: 120,
                g: 60,
                b: 200
            }
        );
    }

    #[test]
    fn hue_diff_wraps_around() {
        assert!((hue_diff(350.0, 10.0) - 20.0).abs() < 1e-9);
        assert!((hue_diff(10.0, 350.0) - 20.0).abs() < 1e-9);
        assert!((hue_diff(0.0, 180.0) - 180.0).abs() < 1e-9);
        assert!((hue_diff(90.0, 90.0)).abs() < 1e-9);
    }
}
