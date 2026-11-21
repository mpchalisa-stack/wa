// Standards-compliant Code 128B 1D Barcode generator (pure TypeScript, zero dependencies)

const CODE128_PATTERNS: string[] = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100',
  '10001001100', '10011001000', '10011000100', '10001100100', '11001001000',
  '11001000100', '11000100100', '10110011100', '10011011100', '10011001110',
  '10111001100', '10011101100', '10011100110', '11001110010', '11001011100',
  '11001001110', '11011100100', '11001110100', '11101101110', '11101001100',
  '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000',
  '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110', '10001101110',
  '10111011000', '10111000110', '10001110110', '11101110110', '11010001110',
  '11000101110', '11011101000', '11011100010', '11011101110', '11101011000',
  '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100',
  '10010110000', '10010000110', '10000101100', '10000100110', '10110010000',
  '10110000100', '10011010000', '10011000010', '10000110100', '10000110010',
  '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
  '10100111100', '10010111100', '10010011110', '10111100100', '10011110100',
  '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110',
  '10111101000', '10111100010', '11110101000', '11110100010', '10111011110',
  '10111101110', '11101011110', '11110101110', '11010000100', '11010010000',
  '11010011100', '1100011101011',
];

const START_B_INDEX = 104;
const STOP_INDEX = 106;

/**
 * Encodes printable ASCII text (chars 32..126) into a Code 128B binary bar pattern.
 */
export function encodeCode128B(rawText: string): string {
  const sanitized = rawText.replace(/[^\x20-\x7E]/g, '') || 'WA6';
  const codes: number[] = [START_B_INDEX];
  let checksum = START_B_INDEX;

  for (let i = 0; i < sanitized.length; i++) {
    const val = sanitized.charCodeAt(i) - 32;
    codes.push(val);
    checksum += val * (i + 1);
  }

  const checkDigit = checksum % 103;
  codes.push(checkDigit);
  codes.push(STOP_INDEX);

  return codes.map((c) => CODE128_PATTERNS[c]).join('');
}

/**
 * Converts an SVG element into a downloadable PNG image with crisp white card padding.
 */
export function downloadSvgAsPng(
  svgElement: SVGSVGElement | null,
  fileName: string,
  titleText?: string,
  subtitleText?: string
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!svgElement) {
      resolve(false);
      return;
    }

    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgElement);
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      const padX = 48;
      const padTop = titleText ? 72 : 40;
      const padBottom = subtitleText ? 64 : 40;
      const drawW = Math.max(320, img.width * 2);
      const drawH = Math.max(160, img.height * 2);

      const canvas = document.createElement('canvas');
      canvas.width = drawW + padX * 2;
      canvas.height = drawH + padTop + padBottom;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        resolve(false);
        return;
      }

      // White card background
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Brand header stripe
      ctx.fillStyle = '#008069';
      ctx.fillRect(0, 0, canvas.width, 10);

      if (titleText) {
        ctx.fillStyle = '#111B21';
        ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(titleText, canvas.width / 2, 48);
      }

      ctx.drawImage(img, padX, padTop, drawW, drawH);

      if (subtitleText) {
        ctx.fillStyle = '#54656F';
        ctx.font = '600 18px ui-monospace, SFMono-Regular, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(subtitleText, canvas.width / 2, padTop + drawH + 38);
      }

      const pngUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = pngUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      URL.revokeObjectURL(url);
      resolve(true);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(false);
    };

    img.src = url;
  });
}
