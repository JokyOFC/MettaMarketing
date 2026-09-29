// Metta product UI kit. Import everything from here:
//   import { Button, PageHeader, DataTable, useApi, formatDate } from "../../ui/index.js";
// Styles live in app.css (prefix ui-, tokens --app-*) and are scoped to the
// `.app` root the shell renders. Slice CSS should be imported after this module.
//
// Conventions
// - Native controls (Input, Textarea, Select, DateInput) keep native onChange(event)
//   and also accept onValueChange(value). Checkbox/Switch: onCheckedChange(bool).
// - Icons: pass a lucide component (icon={Download}), an element, or a name from
//   ICONS (icon="download"). <Icon icon={X} /> renders with strokeWidth 1.4.
// - Status copy and tones come from status.js; never color-only meaning.
import "./app.css";

export { Icon, ICONS, MEDIA_ICONS, Spinner, renderIcon } from "./Icon.jsx";
export { Button, IconButton } from "./Button.jsx";
export { Tooltip } from "./Tooltip.jsx";
export { Menu, Modal, Drawer, ConfirmDialog } from "./overlay.jsx";
export {
  Field,
  Input,
  Textarea,
  Select,
  Checkbox,
  Switch,
  TagInput,
  DateInput,
  SearchInput,
  focusFirstInvalid,
} from "./forms.jsx";
export {
  Badge,
  StatusBadge,
  Kbd,
  Avatar,
  ProgressBar,
  Skeleton,
  SkeletonRows,
  SkeletonCards,
  EmptyState,
  ErrorState,
  CopyButton,
} from "./display.jsx";
export { Card, Panel, PageHeader, Stat, FilterBar, Breadcrumbs } from "./layout.jsx";
export { Tabs, Segmented, Pagination } from "./nav.jsx";
export { Thumb, FileGlyph, FileMeta, Checker, Dropzone } from "./media.jsx";
export { DataTable, BulkBar, BulkJump, focusBulkBar, registerBulkBar, BULK_SHORTCUT } from "./table.jsx";
export { ToastProvider, useToast } from "./toast.jsx";
export {
  useApi,
  useMutation,
  useDebounced,
  useMediaQuery,
  useReducedMotion,
  useIsNarrow,
  useSelection,
  useCopy,
  copyText,
  COPY_FAILED_MESSAGE,
  useLatest,
} from "./hooks.js";
export * from "./format.js";
export {
  STATUS,
  LABELS,
  statusInfo,
  statusLabel,
  statusTone,
  statusOptions,
  label,
  labelOptions,
  roleLabel,
  networkLabel,
  postFormatLabel,
  fileRoleLabel,
  mediaKindLabel,
  variantLabel,
  areaLabel,
} from "./status.js";
