import React from "react";
import { AlertCircle, Archive, File as FileIconBase, FileImage, FileText, ImageIcon, UploadCloud, X } from "lucide-react";
import { formatBytes, useFileUpload } from "@/hooks/use-file-upload";
import { cn } from "@/lib/style";
import { Button } from "./button";

export type FileUploadVariant = "compact" | "list" | "gallery" | "cover" | "avatar";

/** Remote file metadata to render before the user selects local files. Use an image MIME type plus url when the file should show a preview. */
export type FileUploadMetadata = {
  id: string;
  name: string;
  size: number;
  type: string;
  url: string;
};

/** Current selected files. Local entries keep the File in file; remote entries keep FileUploadMetadata in file. */
export type FileUploadItem = {
  file: File | FileUploadMetadata;
  id: string;
  preview?: string;
};

export type FileUploadValue = FileUploadItem[];

export type FileUploadProps = {
  value?: FileUploadMetadata | FileUploadMetadata[];
  variant?: FileUploadVariant;
  accept?: string;
  multiple?: boolean;
  maxFiles?: number;
  maxSize?: number;
  label?: string;
  description?: string;
  className?: string;
  disabled?: boolean;
  onFileChange?: (file: File | null, item: FileUploadItem | null) => void;
  onFilesChange?: (files: FileUploadValue) => void;
};

const IMAGE_VARIANTS = new Set<FileUploadVariant>(["gallery", "cover", "avatar"]);
const SINGLE_FILE_VARIANTS = new Set<FileUploadVariant>(["cover", "avatar"]);
const EMPTY_FILE_UPLOAD_METADATA: FileUploadMetadata[] = [];

const isImageFile = (file: File | FileUploadMetadata) => file.type.startsWith("image/");
const getFileTypeLabel = (file: File | FileUploadMetadata) => {
  const type = file.type.toLowerCase();
  if (type.startsWith("image/")) return "Image";
  if (type.includes("pdf")) return "PDF";
  if (type.includes("zip") || type.includes("rar") || type.includes("archive")) return "Archive";
  if (type.includes("word") || file.name.match(/\.(doc|docx)$/i)) return "Word";
  if (type.includes("sheet") || file.name.match(/\.(xls|xlsx|csv)$/i)) return "Sheet";
  return type.split("/").pop()?.toUpperCase() || "File";
};
const getAcceptLabel = (accept: string) => (accept === "*" ? "Any file type" : accept.replaceAll(",", ", "));

function FileIcon({ file, className }: { file: File | FileUploadMetadata; className?: string }) {
  const type = file.type.toLowerCase();
  if (type.startsWith("image/")) return <FileImage className={className} aria-hidden="true" />;
  if (type.includes("pdf") || type.includes("text") || file.name.match(/\.(txt|md|json|pdf)$/i)) return <FileText className={className} aria-hidden="true" />;
  if (type.includes("zip") || type.includes("rar") || type.includes("archive")) return <Archive className={className} aria-hidden="true" />;
  return <FileIconBase className={className} aria-hidden="true" />;
}

/**
 * File picker for documents or images. Use `cover`/`avatar` for one image, `gallery` for image sets, and `list`/`compact` for mixed files. Selection state only; wire real uploads in app code.
 * @param value Existing file metadata; `cover`/`avatar` accept one object.
 * @param variant Controls the preview shape. Image variants default to `accept='image/*'`.
 * @param onFileChange Single-file callback; new local selections arrive as `file`.
 * @param onFilesChange Full selected list for multi-file inputs.
 * @example <FileUpload variant="cover" value={image} onFileChange={(file) => setImageFile(file)} />
 * @example <FileUpload variant="list" accept=".pdf,.docx,image/*" multiple maxFiles={6} onFilesChange={(files) => setFiles(files)} />
 * @see https://reui.io/docs/components/base/file-upload
 */
const FileUpload = React.forwardRef<HTMLDivElement, FileUploadProps>(({ value, variant = "list", accept, multiple, maxFiles, maxSize = 10 * 1024 * 1024, label, description, className, disabled, onFileChange, onFilesChange }, ref) => {
  const imageVariant = IMAGE_VARIANTS.has(variant);
  const singleFile = SINGLE_FILE_VARIANTS.has(variant);
  const initialFiles = React.useMemo(() => (Array.isArray(value) ? value : value ? [value] : EMPTY_FILE_UPLOAD_METADATA), [value]);
  const resolvedAccept = accept ?? (imageVariant ? "image/*" : "*");
  const resolvedMultiple = singleFile ? false : (multiple ?? true);
  const resolvedMaxFiles = resolvedMultiple ? (maxFiles ?? (variant === "gallery" ? 10 : 5)) : 1;
  const [{ files, isDragging, errors }, { removeFile, clearFiles, handleDragEnter, handleDragLeave, handleDragOver, handleDrop, openFileDialog, getInputProps }] = useFileUpload({
    maxFiles: resolvedMaxFiles,
    maxSize,
    accept: resolvedAccept,
    multiple: resolvedMultiple,
    initialFiles,
    onFilesChange: (nextFiles) => {
      const firstFile = nextFiles[0] ?? null;
      const localFile = firstFile?.file;
      onFileChange?.(localFile instanceof File ? localFile : null, firstFile);
      onFilesChange?.(nextFiles);
    },
  });
  const primaryFile = files[0];
  const detailText = description ?? `${getAcceptLabel(resolvedAccept)} up to ${formatBytes(maxSize)}${resolvedMultiple ? ` each, max ${resolvedMaxFiles} files` : ""}.`;
  const heading = label ?? (variant === "cover" ? "Choose a cover file or drag and drop here" : variant === "avatar" ? "Choose an avatar file or drag and drop here" : "Drop files here or click to browse");
  const canAddMore = resolvedMultiple ? files.length < resolvedMaxFiles : files.length === 0;

  const dropzoneProps = {
    onDragEnter: disabled ? undefined : handleDragEnter,
    onDragLeave: disabled ? undefined : handleDragLeave,
    onDragOver: disabled ? undefined : handleDragOver,
    onDrop: disabled ? undefined : handleDrop,
  };

  const emptyState = (
    <button
      type="button"
      className={cn("flex w-full cursor-pointer flex-col items-center justify-center gap-3 p-6 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#EE5C2A]/30", variant === "avatar" ? "aspect-square rounded-full" : "min-h-[168px]")}
      onClick={openFileDialog}
      disabled={disabled}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#EE5C2A]/10 text-[#EE5C2A]">{imageVariant ? <ImageIcon className="h-6 w-6" aria-hidden="true" /> : <UploadCloud className="h-6 w-6" aria-hidden="true" />}</span>
      <span className="space-y-1">
        <span className="block text-sm font-semibold text-[#171411]">{heading}</span>
        <span className="block text-xs leading-5 text-[#8A7E72]">{detailText}</span>
      </span>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-white/82 px-3 py-1 text-xs font-medium text-[#6F655B] shadow-sm">
        <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />
        Browse files
      </span>
    </button>
  );

  const singleContent = primaryFile ? (
    primaryFile.preview ? (
      <div className={cn("relative w-full overflow-hidden", variant === "avatar" ? "aspect-square rounded-full" : "aspect-[21/9]")}>
        <img src={primaryFile.preview} alt={`Preview of ${primaryFile.file.name}`} className="h-full w-full object-cover" />
        <div className="absolute inset-0 bg-black/0 transition-colors duration-200 group-hover:bg-black/35" />
        <div className={cn("absolute flex gap-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100", variant === "avatar" ? "inset-x-3 bottom-3 justify-center" : "inset-x-3 bottom-3 flex-wrap items-center justify-between")}>
          {variant === "cover" ? <div className="min-w-0 rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-[#2D2925] shadow-sm backdrop-blur">{primaryFile.file.name}</div> : null}
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 rounded-full bg-white/90 px-3 shadow-sm backdrop-blur" onClick={openFileDialog} disabled={disabled}>
            <UploadCloud className="h-3.5 w-3.5" />
            Change
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 rounded-full bg-white/90 px-3 text-[#A33D3D] shadow-sm backdrop-blur hover:text-[#7F2E2E]" onClick={() => removeFile(primaryFile.id)} disabled={disabled}>
            <X className="h-3.5 w-3.5" />
            Remove
          </Button>
        </div>
      </div>
    ) : (
      <div className="flex min-h-[132px] flex-col justify-center gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-[#F8F6F2] text-[#8A7E72]">
            <FileIcon file={primaryFile.file} className="h-5 w-5" />
          </span>
          <span className="min-w-0 space-y-1">
            <span className="block truncate text-sm font-medium text-[#2D2925]">{primaryFile.file.name}</span>
            <span className="block text-xs text-[#8A7E72]">
              {getFileTypeLabel(primaryFile.file)} · {formatBytes(primaryFile.file.size)}
            </span>
          </span>
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 rounded-full bg-white/90 px-3 shadow-sm" onClick={openFileDialog} disabled={disabled}>
            <UploadCloud className="h-3.5 w-3.5" />
            Change
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 rounded-full bg-white/90 px-3 text-[#A33D3D] shadow-sm hover:text-[#7F2E2E]" onClick={() => removeFile(primaryFile.id)} disabled={disabled}>
            <X className="h-3.5 w-3.5" />
            Remove
          </Button>
        </div>
      </div>
    )
  ) : (
    emptyState
  );

  return (
    <div ref={ref} data-slot="file-upload" className={cn("w-full space-y-3", className)}>
      <input {...getInputProps({ disabled, "aria-label": heading })} className="sr-only" tabIndex={-1} />
      {variant === "cover" || variant === "avatar" ? (
        <div
          {...dropzoneProps}
          className={cn(
            "group relative overflow-hidden border transition-[background-color,border-color,box-shadow] duration-200",
            variant === "avatar" && (!primaryFile || primaryFile.preview) ? "mx-auto max-w-[180px] rounded-full" : "rounded-[18px]",
            isDragging ? "border-[#EE5C2A] border-dashed bg-[#FFF3EA] shadow-[0_0_0_3px_rgba(238,92,42,0.10)]" : primaryFile ? "border-black/[0.08] bg-white/82 hover:border-black/[0.14]" : "border-dashed border-black/[0.12] bg-[#F8F6F2] hover:border-[#EE5C2A]/60 hover:bg-[#FFF8F4]",
            disabled && "pointer-events-none opacity-55",
          )}
        >
          {singleContent}
        </div>
      ) : (
        <>
          {canAddMore ? (
            <div
              {...dropzoneProps}
              className={cn(
                "overflow-hidden rounded-[18px] border border-dashed transition-[background-color,border-color,box-shadow] duration-200",
                isDragging ? "border-[#EE5C2A] bg-[#FFF3EA] shadow-[0_0_0_3px_rgba(238,92,42,0.10)]" : "border-black/[0.12] bg-[#F8F6F2] hover:border-[#EE5C2A]/60 hover:bg-[#FFF8F4]",
                disabled && "pointer-events-none opacity-55",
              )}
            >
              {emptyState}
            </div>
          ) : null}
          {files.length > 0 ? <FileUploadFiles files={files} variant={variant} disabled={disabled} removeFile={removeFile} clearFiles={clearFiles} maxFiles={resolvedMaxFiles} /> : null}
        </>
      )}
      {errors.length > 0 ? (
        <div role="alert" className="flex gap-2 rounded-[14px] border border-[#F3D0D0] bg-[#FFF4F4] px-3 py-2 text-xs leading-5 text-[#A33D3D]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="space-y-1">
            {errors.map((error) => (
              <p key={error} className="m-0">
                {error}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
});

FileUpload.displayName = "FileUpload";

function FileUploadFiles({ files, variant, disabled, removeFile, clearFiles, maxFiles }: { files: FileUploadValue; variant: FileUploadVariant; disabled?: boolean; removeFile: (id: string) => void; clearFiles: () => void; maxFiles: number }) {
  if (variant === "gallery") {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3 text-xs text-[#8A7E72]">
          <span>
            Gallery ({files.length}/{maxFiles})
          </span>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={clearFiles} disabled={disabled}>
            Clear
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {files.map((item) => (
            <div key={item.id} className="group relative overflow-hidden rounded-[14px] border border-black/[0.08] bg-white/82">
              <div className="aspect-square">
                {item.preview && isImageFile(item.file) ? (
                  <img src={item.preview} alt={`Preview of ${item.file.name}`} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-[#F8F6F2] text-[#8A7E72]">
                    <FileIcon file={item.file} className="h-8 w-8" />
                  </div>
                )}
              </div>
              <div className="space-y-0.5 p-2">
                <div className="truncate text-xs font-medium text-[#2D2925]">{item.file.name}</div>
                <div className="text-[11px] text-[#8A7E72]">{formatBytes(item.file.size)}</div>
              </div>
              <Button type="button" variant="outline" size="icon" className="absolute right-2 top-2 h-7 w-7 rounded-full bg-white/90 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100" onClick={() => removeFile(item.id)} disabled={disabled} aria-label={`Remove ${item.file.name}`}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <div className="flex flex-wrap gap-2">
        {files.map((item) => (
          <span key={item.id} className="inline-flex max-w-full items-center gap-2 rounded-full border border-black/[0.08] bg-white/82 px-3 py-1.5 text-xs text-[#4F463F] shadow-sm">
            <FileIcon file={item.file} className="h-3.5 w-3.5 shrink-0 text-[#8A7E72]" />
            <span className="truncate">{item.file.name}</span>
            <button type="button" className="shrink-0 rounded-full p-0.5 text-[#A33D3D] hover:bg-[#FFF4F4]" onClick={() => removeFile(item.id)} disabled={disabled} aria-label={`Remove ${item.file.name}`}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[14px] border border-black/[0.08] bg-white/82">
      <div className="grid grid-cols-[minmax(0,1fr)_88px_88px_44px] gap-3 border-b border-black/[0.06] px-3 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[#A69B90]">
        <span>Name</span>
        <span>Type</span>
        <span>Size</span>
        <span />
      </div>
      {files.map((item) => (
        <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_88px_88px_44px] items-center gap-3 border-b border-black/[0.06] px-3 py-2 last:border-b-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[#F8F6F2] text-[#8A7E72]">
              <FileIcon file={item.file} className="h-4 w-4" />
            </span>
            <span className="truncate text-sm font-medium text-[#2D2925]">{item.file.name}</span>
          </div>
          <span className="truncate text-xs text-[#8A7E72]">{getFileTypeLabel(item.file)}</span>
          <span className="truncate text-xs text-[#8A7E72]">{formatBytes(item.file.size)}</span>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-[#A33D3D]" onClick={() => removeFile(item.id)} disabled={disabled} aria-label={`Remove ${item.file.name}`}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}

export { FileUpload };
