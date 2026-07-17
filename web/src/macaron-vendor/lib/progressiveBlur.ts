export function getProgressiveBlurLayerStyle({ layer, segmentSize, blur, gradientDirection, unit = "%", maskColor = "0,0,0", stopScale = 1 }: { layer: number; segmentSize: number; blur: number; gradientDirection: string; unit?: "%" | "rem"; maskColor?: string; stopScale?: number }) {
  const stops = [layer, layer + 1, layer + 2, layer + 3].map((index, stopIndex) => `rgba(${maskColor},${stopIndex === 1 || stopIndex === 2 ? 1 : 0}) ${index * segmentSize * stopScale}${unit}`).join(", ");
  const gradient = `linear-gradient(${gradientDirection}, ${stops})`;
  return { maskImage: gradient, WebkitMaskImage: gradient, backdropFilter: `blur(${blur}px)`, WebkitBackdropFilter: `blur(${blur}px)` };
}
