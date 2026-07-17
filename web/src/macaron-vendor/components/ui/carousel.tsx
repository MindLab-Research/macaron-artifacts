import React from "react";
import useEmblaCarousel, { type UseEmblaCarouselType } from "embla-carousel-react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/style";

type CarouselApi = UseEmblaCarouselType[1];
type UseCarouselParameters = Parameters<typeof useEmblaCarousel>;
type CarouselOptions = UseCarouselParameters[0];
type CarouselPlugin = UseCarouselParameters[1];
type CarouselOrientation = "horizontal" | "vertical";
type CarouselContextValue = {
  carouselRef: UseEmblaCarouselType[0];
  api: CarouselApi;
  scrollPrev: () => void;
  scrollNext: () => void;
  canScrollPrev: boolean;
  canScrollNext: boolean;
  orientation: CarouselOrientation;
};
type CarouselProps = React.HTMLAttributes<HTMLDivElement> & {
  opts?: CarouselOptions;
  plugins?: CarouselPlugin;
  orientation?: CarouselOrientation;
  setApi?: (api: CarouselApi) => void;
  items?: React.ReactNode[];
};

const CarouselContext = React.createContext<CarouselContextValue | null>(null);

function useCarousel() {
  const context = React.useContext(CarouselContext);
  if (!context) throw new Error("Carousel compound components must be used inside Carousel.");
  return context;
}

/**
 * Swipeable Embla carousel. Prefer CarouselContent/CarouselItem composition; the `items` prop remains as a compact backwards-compatible shortcut.
 * @param opts Embla options such as `{ align: "start", loop: true }`.
 * @param setApi Receives the Embla API for current-slide counters or custom controls.
 * @example <Carousel><CarouselContent><CarouselItem>Slide</CarouselItem></CarouselContent><CarouselPrevious /><CarouselNext /></Carousel>
 * @see https://ui.shadcn.com/docs/components/radix/carousel
 */
function Carousel({ orientation = "horizontal", opts, setApi, plugins, className, children, items, ...props }: CarouselProps) {
  const [carouselRef, api] = useEmblaCarousel({ ...opts, axis: orientation === "horizontal" ? "x" : "y" }, plugins);
  const [canScrollPrev, setCanScrollPrev] = React.useState(false);
  const [canScrollNext, setCanScrollNext] = React.useState(false);
  const safeItems = Array.isArray(items) ? items : [];
  const onSelect = React.useCallback((api: CarouselApi) => {
    if (!api) return;
    setCanScrollPrev(api.canScrollPrev());
    setCanScrollNext(api.canScrollNext());
  }, []);
  const scrollPrev = React.useCallback(() => api?.scrollPrev(), [api]);
  const scrollNext = React.useCallback(() => api?.scrollNext(), [api]);
  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        scrollPrev();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        scrollNext();
      }
    },
    [scrollNext, scrollPrev],
  );

  React.useEffect(() => {
    if (!api) return;
    setApi?.(api);
    onSelect(api);
    api.on("reInit", onSelect);
    api.on("select", onSelect);
    return () => {
      api.off("select", onSelect);
      api.off("reInit", onSelect);
    };
  }, [api, onSelect, setApi]);

  const resolvedChildren =
    children ??
    (safeItems.length > 0 ? (
      <>
        <CarouselContent>
          {safeItems.map((item, index) => (
            <CarouselItem key={React.isValidElement(item) && item.key !== null ? item.key : `carousel-item-${index}`}>{item}</CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious />
        <CarouselNext />
      </>
    ) : null);
  const contextValue = React.useMemo(() => ({ carouselRef, api, scrollPrev, scrollNext, canScrollPrev, canScrollNext, orientation }), [api, canScrollNext, canScrollPrev, carouselRef, orientation, scrollNext, scrollPrev]);

  return (
    <CarouselContext.Provider value={contextValue}>
      <div data-slot="carousel" data-orientation={orientation} role="region" aria-roledescription="carousel" className={cn("relative", className)} onKeyDownCapture={handleKeyDown} {...props}>
        {resolvedChildren}
      </div>
    </CarouselContext.Provider>
  );
}

/** Viewport and track wrapper for CarouselItem children. */
const CarouselContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => {
  const { carouselRef, orientation } = useCarousel();
  return (
    <div ref={carouselRef} data-slot="carousel-viewport" className="overflow-hidden">
      <div ref={ref} data-slot="carousel-content" className={cn("flex", orientation === "horizontal" ? "-ml-4" : "-mt-4 flex-col", className)} {...props} />
    </div>
  );
});
CarouselContent.displayName = "CarouselContent";

/** Single carousel slide. Adjust basis classes here for multi-card carousels. */
const CarouselItem = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => {
  const { orientation } = useCarousel();
  return <div ref={ref} data-slot="carousel-item" role="group" aria-roledescription="slide" className={cn("min-w-0 shrink-0 grow-0 basis-full", orientation === "horizontal" ? "pl-4" : "pt-4", className)} {...props} />;
});
CarouselItem.displayName = "CarouselItem";

/** Previous-slide control. */
function CarouselPrevious({ className, variant = "outline", size = "icon", ...props }: React.ComponentProps<typeof Button>) {
  const { orientation, scrollPrev, canScrollPrev } = useCarousel();
  return (
    <Button data-slot="carousel-previous" variant={variant} size={size} className={cn("absolute h-8 w-8 rounded-full", orientation === "horizontal" ? "-left-4 top-1/2 -translate-y-1/2" : "-top-4 left-1/2 -translate-x-1/2 rotate-90", className)} disabled={!canScrollPrev} onClick={scrollPrev} {...props}>
      <ArrowLeft className="h-4 w-4" />
      <span className="sr-only">Previous slide</span>
    </Button>
  );
}

/** Next-slide control. */
function CarouselNext({ className, variant = "outline", size = "icon", ...props }: React.ComponentProps<typeof Button>) {
  const { orientation, scrollNext, canScrollNext } = useCarousel();
  return (
    <Button data-slot="carousel-next" variant={variant} size={size} className={cn("absolute h-8 w-8 rounded-full", orientation === "horizontal" ? "-right-4 top-1/2 -translate-y-1/2" : "-bottom-4 left-1/2 -translate-x-1/2 rotate-90", className)} disabled={!canScrollNext} onClick={scrollNext} {...props}>
      <ArrowRight className="h-4 w-4" />
      <span className="sr-only">Next slide</span>
    </Button>
  );
}

export { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious, type CarouselApi };
