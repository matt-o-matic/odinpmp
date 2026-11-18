export const MAX_AVATAR_DATA_URL_LENGTH = 700_000;
export const MAX_AVATAR_DIMENSION = 512;
export const AVATAR_TOO_LARGE_MESSAGE = 'Avatar image is too large. Please choose an image under 512 KB.';

const DEFAULT_OUTPUT_QUALITIES = [0.92, 0.86, 0.8, 0.74, 0.68, 0.6];

function defaultReadFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read the selected image.'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  });
}

function defaultLoadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('Unable to load the selected image.'));
    image.onload = () => resolve(image);
    image.src = dataUrl;
  });
}

function defaultCreateCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function scaleAvatarDimensions(width, height, maxDimension = MAX_AVATAR_DIMENSION) {
  const normalizedWidth = Math.max(1, Number(width) || 1);
  const normalizedHeight = Math.max(1, Number(height) || 1);
  const largestDimension = Math.max(normalizedWidth, normalizedHeight);

  if (largestDimension <= maxDimension) {
    return {
      height: normalizedHeight,
      width: normalizedWidth,
    };
  }

  const scale = maxDimension / largestDimension;

  return {
    height: Math.max(1, Math.round(normalizedHeight * scale)),
    width: Math.max(1, Math.round(normalizedWidth * scale)),
  };
}

function isDataUrlWithinLimit(dataUrl, maxDataUrlLength) {
  return String(dataUrl ?? '').length > 0 && String(dataUrl ?? '').length <= maxDataUrlLength;
}

export async function normalizeAvatarUpload(file, options = {}) {
  const {
    createCanvas = defaultCreateCanvas,
    loadImage = defaultLoadImage,
    maxDataUrlLength = MAX_AVATAR_DATA_URL_LENGTH,
    maxDimension = MAX_AVATAR_DIMENSION,
    outputQualities = DEFAULT_OUTPUT_QUALITIES,
    readFileAsDataUrl = defaultReadFileAsDataUrl,
  } = options;

  const sourceDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(sourceDataUrl);
  const { width, height } = scaleAvatarDimensions(image.width, image.height, maxDimension);

  if (
    isDataUrlWithinLimit(sourceDataUrl, maxDataUrlLength)
    && width === image.width
    && height === image.height
  ) {
    return {
      dataUrl: sourceDataUrl,
      height,
      width,
    };
  }

  const canvas = createCanvas(width, height);
  const context = canvas.getContext?.('2d');

  if (!context) {
    throw new Error('Unable to process the selected image.');
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  for (const quality of outputQualities) {
    const candidate = canvas.toDataURL('image/jpeg', quality);
    if (isDataUrlWithinLimit(candidate, maxDataUrlLength)) {
      return {
        dataUrl: candidate,
        height,
        width,
      };
    }
  }

  throw new Error(AVATAR_TOO_LARGE_MESSAGE);
}
