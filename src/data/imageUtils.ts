/**
 * Compress an image (base64 dataURL) to a max size before saving to Firebase.
 * Reduces file size from 100-500KB to 5-15KB per image.
 */

const MAX_DIMENSION = 128; // px — good for hover tooltips
const QUALITY       = 0.7; // JPEG quality

export function compressImage(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // If not an image dataURL, return as-is
    if (!dataUrl.startsWith("data:image/")) {
      resolve(dataUrl);
      return;
    }

    const img = new Image();

    img.onload = () => {
      const { width, height } = img;

      // Calculate new dimensions keeping aspect ratio
      let newW = width;
      let newH = height;
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        if (width > height) {
          newW = MAX_DIMENSION;
          newH = Math.round(height * MAX_DIMENSION / width);
        } else {
          newH = MAX_DIMENSION;
          newW = Math.round(width * MAX_DIMENSION / height);
        }
      }

      // If already small enough, return as-is
      if (newW === width && newH === height && dataUrl.length < 20_000) {
        resolve(dataUrl);
        return;
      }

      const canvas  = document.createElement("canvas");
      canvas.width  = newW;
      canvas.height = newH;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, newW, newH);

      // Use JPEG for photos (smaller), PNG for transparency
      const mimeType = dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg";
      const compressed = canvas.toDataURL(mimeType, QUALITY);

      const origKB  = Math.round(dataUrl.length / 1024);
      const newKB   = Math.round(compressed.length / 1024);
      console.log(`Image compressed: ${origKB}KB → ${newKB}KB (${newW}×${newH}px)`);

      resolve(compressed);
    };

    img.onerror = () => reject(new Error("Image load failed"));
    img.src = dataUrl;
  });
}

/**
 * Compress multiple images in parallel, with a concurrency limit.
 */
export async function compressImages(
  items: Array<{ classname: string; imageUrl?: string }>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  await Promise.all(
    items
      .filter(item => item.imageUrl)
      .map(async item => {
        try {
          const compressed = await compressImage(item.imageUrl!);
          result.set(item.classname, compressed);
        } catch (e) {
          console.warn(`Could not compress image for ${item.classname}:`, e);
          result.set(item.classname, item.imageUrl!);
        }
      })
  );
  return result;
}
