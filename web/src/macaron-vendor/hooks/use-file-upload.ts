import type React from "react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type InputHTMLAttributes } from "react";

export type FileMetadata = {
  name: string;
  size: number;
  type: string;
  url: string;
  id: string;
};

export type FileWithPreview = {
  file: File | FileMetadata;
  id: string;
  preview?: string;
};

export type FileUploadOptions = {
  maxFiles?: number;
  maxSize?: number;
  accept?: string;
  multiple?: boolean;
  initialFiles?: FileMetadata[];
  onFilesChange?: (files: FileWithPreview[]) => void;
  onFilesAdded?: (addedFiles: FileWithPreview[]) => void;
  onError?: (errors: string[]) => void;
};

export type FileUploadState = {
  files: FileWithPreview[];
  isDragging: boolean;
  errors: string[];
};

export type FileUploadActions = {
  addFiles: (files: FileList | File[]) => void;
  removeFile: (id: string) => void;
  clearFiles: () => void;
  clearErrors: () => void;
  handleDragEnter: (event: DragEvent<HTMLElement>) => void;
  handleDragLeave: (event: DragEvent<HTMLElement>) => void;
  handleDragOver: (event: DragEvent<HTMLElement>) => void;
  handleDrop: (event: DragEvent<HTMLElement>) => void;
  handleFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  openFileDialog: () => void;
  getInputProps: (props?: InputHTMLAttributes<HTMLInputElement>) => InputHTMLAttributes<HTMLInputElement> & { ref: React.Ref<HTMLInputElement> };
};

const EMPTY_INITIAL_FILES: FileMetadata[] = [];

export const formatBytes = (bytes: number, decimals = 2): string => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = Math.max(0, decimals);
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
};

const revokeFilePreview = (file: FileWithPreview) => {
  if (file.preview && file.file instanceof File && file.file.type.startsWith("image/")) URL.revokeObjectURL(file.preview);
};
const metadataToFileWithPreview = (file: FileMetadata): FileWithPreview => ({ file, id: file.id, preview: file.type.startsWith("image/") ? file.url : undefined });

export const useFileUpload = (options: FileUploadOptions = {}): [FileUploadState, FileUploadActions] => {
  const { maxFiles = Number.POSITIVE_INFINITY, maxSize = Number.POSITIVE_INFINITY, accept = "*", multiple = false, initialFiles = EMPTY_INITIAL_FILES, onFilesChange, onFilesAdded, onError } = options;
  const [state, setState] = useState<FileUploadState>({
    files: initialFiles.map(metadataToFileWithPreview),
    isDragging: false,
    errors: [],
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef(state.files);
  const initialFilesRef = useRef(initialFiles);
  initialFilesRef.current = initialFiles;
  // Reset only when the metadata content changes, not on every new `value` reference (inline-derived props change identity each render).
  const initialFilesKey = initialFiles.map((file) => `${file.id}:${file.url}:${file.name}:${file.size}:${file.type}`).join(" ");

  const setFilesState = useCallback((files: FileWithPreview[], errors: string[] = []) => {
    filesRef.current = files;
    setState((prev) => ({ ...prev, files, errors }));
  }, []);

  useEffect(() => {
    filesRef.current = state.files;
  }, [state.files]);

  useEffect(() => {
    const files = initialFilesRef.current.map(metadataToFileWithPreview);
    for (const file of filesRef.current) revokeFilePreview(file);
    if (inputRef.current) inputRef.current.value = "";
    setFilesState(files);
  }, [initialFilesKey, setFilesState]);

  useEffect(
    () => () => {
      for (const file of filesRef.current) revokeFilePreview(file);
    },
    [],
  );

  const validateFile = useCallback(
    (file: File | FileMetadata): string | null => {
      if (file.size > maxSize) return `File "${file.name}" exceeds the maximum size of ${formatBytes(maxSize)}.`;
      if (accept === "*") return null;
      const acceptedTypes = accept.split(",").map((type) => type.trim());
      const fileType = file instanceof File ? file.type || "" : file.type;
      const fileExtension = `.${file.name.split(".").pop()}`;
      const isAccepted = acceptedTypes.some((type) => {
        if (type.startsWith(".")) return fileExtension.toLowerCase() === type.toLowerCase();
        if (type.endsWith("/*")) return fileType.startsWith(`${type.split("/")[0]}/`);
        return fileType === type;
      });
      return isAccepted ? null : `File "${file.name}" is not an accepted file type.`;
    },
    [accept, maxSize],
  );

  const createPreview = useCallback((file: File | FileMetadata): string | undefined => (file.type.startsWith("image/") ? (file instanceof File ? URL.createObjectURL(file) : file.url) : undefined), []);
  const generateUniqueId = useCallback((file: File | FileMetadata): string => (file instanceof File ? `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}` : file.id), []);

  const clearFiles = useCallback(() => {
    for (const file of filesRef.current) revokeFilePreview(file);
    if (inputRef.current) inputRef.current.value = "";
    setFilesState([]);
    onFilesChange?.([]);
  }, [onFilesChange, setFilesState]);

  const addFiles = useCallback(
    (newFiles: FileList | File[]) => {
      if (!newFiles || newFiles.length === 0) return;
      const newFilesArray = multiple ? Array.from(newFiles) : Array.from(newFiles).slice(0, 1);
      const currentFiles = filesRef.current;
      const errors: string[] = [];
      setState((prev) => ({ ...prev, errors: [] }));

      const validFiles: FileWithPreview[] = [];
      let reachedLimit = false;
      for (const file of newFilesArray) {
        if (multiple) {
          const isDuplicate = currentFiles.some((existingFile) => existingFile.file.name === file.name && existingFile.file.size === file.size);
          if (isDuplicate) continue;
        }
        const error = validateFile(file);
        if (error) {
          errors.push(error);
          continue;
        }
        // enforce the cap on what would actually be added, after dedup/validation
        if (multiple && currentFiles.length + validFiles.length >= maxFiles) {
          reachedLimit = true;
          break;
        }
        validFiles.push({ file, id: generateUniqueId(file), preview: createPreview(file) });
      }
      if (reachedLimit) errors.push(`You can only upload a maximum of ${maxFiles} files.`);

      if (validFiles.length > 0) {
        onFilesAdded?.(validFiles);
        if (!multiple) for (const file of currentFiles) revokeFilePreview(file);
        const files = multiple ? [...currentFiles, ...validFiles] : validFiles;
        setFilesState(files, errors);
        onFilesChange?.(files);
        if (errors.length > 0) onError?.(errors);
      } else if (errors.length > 0) {
        onError?.(errors);
        setState((prev) => ({ ...prev, errors }));
      }
      if (inputRef.current) inputRef.current.value = "";
    },
    [createPreview, generateUniqueId, maxFiles, multiple, onError, onFilesAdded, onFilesChange, setFilesState, validateFile],
  );

  const removeFile = useCallback(
    (id: string) => {
      const fileToRemove = filesRef.current.find((file) => file.id === id);
      if (fileToRemove) revokeFilePreview(fileToRemove);
      const files = filesRef.current.filter((file) => file.id !== id);
      setFilesState(files);
      onFilesChange?.(files);
    },
    [onFilesChange, setFilesState],
  );

  const clearErrors = useCallback(() => setState((prev) => ({ ...prev, errors: [] })), []);
  const handleDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setState((prev) => ({ ...prev, isDragging: true }));
  }, []);
  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setState((prev) => ({ ...prev, isDragging: false }));
  }, []);
  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setState((prev) => ({ ...prev, isDragging: false }));
      if (inputRef.current?.disabled) return;
      if (event.dataTransfer.files?.length) addFiles(multiple ? event.dataTransfer.files : [event.dataTransfer.files[0]]);
    },
    [addFiles, multiple],
  );
  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (event.target.files?.length) addFiles(event.target.files);
    },
    [addFiles],
  );
  const openFileDialog = useCallback(() => inputRef.current?.click(), []);
  const getInputProps = useCallback((props: InputHTMLAttributes<HTMLInputElement> = {}) => ({ ...props, type: "file" as const, onChange: handleFileChange, accept: props.accept || accept, multiple: props.multiple ?? multiple, ref: inputRef }), [accept, handleFileChange, multiple]);

  return [state, { addFiles, removeFile, clearFiles, clearErrors, handleDragEnter, handleDragLeave, handleDragOver, handleDrop, handleFileChange, openFileDialog, getInputProps }];
};
