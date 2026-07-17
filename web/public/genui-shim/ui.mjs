// $macaron/ui shim — re-exports the real vendored library (src/macaron-vendor/macaron/source.tsx)
// via window.__macaron_UI set by main.tsx. Enumerates ALL 118 exports from source.tsx
// (auto-generated from `grep -oE '^export ...' source.tsx`).
const M = globalThis.__macaron_UI;
if (!M) throw new Error('[genui-shim/ui] window.__macaron_UI not set — make sure main.tsx imported macaron-vendor before mounting GenuiPreview');

export const {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
  AnimatePresence,
  Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage,
  Badge,
  Button,
  Calendar, CalendarDayButton,
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
  Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious,
  Checkbox,
  Disclosure, DisclosureContent, DisclosureTrigger,
  FeatureCard, Field, FileUpload,
  GlowEffect, Grid,
  Input, InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot,
  Label,
  MorphingDialog, MorphingDialogClose, MorphingDialogContainer, MorphingDialogContent,
  MorphingDialogDescription, MorphingDialogImage, MorphingDialogSubtitle,
  MorphingDialogTitle, MorphingDialogTrigger,
  NumberFlow,
  PillRow,
  Popover, PopoverAnchor, PopoverContent, PopoverDescription, PopoverHeader,
  PopoverTitle, PopoverTrigger,
  ProgressiveBlur,
  REGEXP_ONLY_CHARS, REGEXP_ONLY_DIGITS, REGEXP_ONLY_DIGITS_AND_CHARS,
  RadioGroup, RadioGroupItem,
  Row,
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectSeparator, SelectTrigger, SelectValue,
  SelectionGrid,
  Separator, Slider,
  Sortable, SortableItem, SortableItemHandle, SortableOverlay,
  SpinningText, Stack, Stat, StatGrid, Surface, Switch,
  Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow,
  Tabs, TabsContent, TabsList, TabsTrigger,
  Text, TextLoop, TextMorph, TextShimmer, Textarea,
  TickSlider, Tilt,
  Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator,
  TimelineItem, TimelineSeparator, TimelineTitle,
  ToolbarDynamic, TwoColumnGrid,
  motion,
  numberFlowContinuous,
} = M;

export default M;
