/**
 * Client-side high performance image compressor for mobile vehicle photos.
 * Reduces 5-15MB phone photos down to ~300-600KB while preserving VIN/plate clarity.
 */

export interface CompressionOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number; // 0.1 to 1.0 (default: 0.82)
  maxSizeMB?: number; // Target max size in MB (e.g. 1.5MB)
}

export async function compressImage(
  file: File,
  options: CompressionOptions = {},
): Promise<File> {
  const {
    maxWidth = 1920,
    maxHeight = 1920,
    quality = 0.82,
  } = options;

  // If already small enough (under 1MB), skip compression
  if (file.size <= 1024 * 1024 && file.type === "image/jpeg") {
    return file;
  }

  // Only compress images
  if (!file.type.startsWith("image/")) {
    return file;
  }

  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      let width = img.naturalWidth || img.width;
      let height = img.naturalHeight || img.height;

      // Maintain aspect ratio
      if (width > maxWidth || height > maxHeight) {
        if (width / height > maxWidth / maxHeight) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        } else {
          width = Math.round((width * maxHeight) / height);
          height = maxHeight;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(file);
        return;
      }

      // Fill white background in case of transparent PNGs converted to JPEG
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (!blob || blob.size >= file.size) {
            // If compression didn't help, return original
            resolve(file);
            return;
          }

          // Create new file with original name and compressed data
          const newName = file.name.replace(/\.[^/.]+$/, "") + ".jpg";
          const compressedFile = new File([blob], newName, {
            type: "image/jpeg",
            lastModified: Date.now(),
          });

          resolve(compressedFile);
        },
        "image/jpeg",
        quality,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file);
    };

    img.src = objectUrl;
  });
}
