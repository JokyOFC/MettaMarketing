import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Bell,
  Briefcase,
  Building2,
  Calendar,
  CalendarDays,
  ChartColumn,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  Clock,
  CloudUpload,
  Copy,
  CreditCard,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileType,
  FileVideo,
  Files,
  Filter,
  Folder,
  FolderKanban,
  FolderOpen,
  GripVertical,
  Hash,
  History,
  Image,
  Info,
  LayoutDashboard,
  LayoutGrid,
  Library,
  Link,
  List,
  Lock,
  LogOut,
  Mail,
  Menu,
  MessageSquare,
  Minus,
  Package,
  Palette,
  PenTool,
  Pencil,
  Play,
  Plus,
  Receipt,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tag,
  Trash2,
  TriangleAlert,
  Type,
  Unlock,
  User,
  UserCog,
  Users,
  Wallet,
  X,
} from "lucide-react";

// A curated set addressable by name (<Icon name="download" />). Any other
// lucide icon can be passed as a component: <Icon icon={Scissors} />.
export const ICONS = {
  archive: Archive,
  unarchive: ArchiveRestore,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  "arrow-up-right": ArrowUpRight,
  approvals: BadgeCheck,
  bell: Bell,
  notifications: Bell,
  briefcase: Briefcase,
  building: Building2,
  calendar: Calendar,
  content: CalendarDays,
  "calendar-days": CalendarDays,
  chart: ChartColumn,
  reports: ChartColumn,
  check: Check,
  "check-check": CheckCheck,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  alert: CircleAlert,
  error: CircleAlert,
  success: CircleCheck,
  briefings: ClipboardList,
  clock: Clock,
  upload: CloudUpload,
  copy: Copy,
  card: CreditCard,
  download: Download,
  more: Ellipsis,
  external: ExternalLink,
  eye: Eye,
  "eye-off": EyeOff,
  file: File,
  "file-archive": FileArchive,
  "file-audio": FileAudio,
  "file-image": FileImage,
  "file-text": FileText,
  "file-font": FileType,
  "file-video": FileVideo,
  files: Files,
  filter: Filter,
  folder: Folder,
  "folder-open": FolderOpen,
  projects: FolderKanban,
  grip: GripVertical,
  hash: Hash,
  history: History,
  image: Image,
  info: Info,
  overview: LayoutDashboard,
  grid: LayoutGrid,
  library: Library,
  link: Link,
  list: List,
  lock: Lock,
  logout: LogOut,
  mail: Mail,
  menu: Menu,
  comment: MessageSquare,
  minus: Minus,
  services: Package,
  kit: Package,
  brand: Palette,
  palette: Palette,
  design: PenTool,
  edit: Pencil,
  play: Play,
  plus: Plus,
  orders: Receipt,
  refresh: RefreshCw,
  retry: RotateCcw,
  search: Search,
  send: Send,
  settings: Settings,
  shapes: Shapes,
  sliders: SlidersHorizontal,
  sparkles: Sparkles,
  star: Star,
  tag: Tag,
  trash: Trash2,
  warning: TriangleAlert,
  type: Type,
  unlock: Unlock,
  user: User,
  team: UserCog,
  clients: Users,
  users: Users,
  finance: Wallet,
  close: X,
  x: X,
};

const toKey = (name) =>
  String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();

// Thin lucide wrapper with the product stroke (1.4). Decorative by default;
// pass `label` when the icon alone carries meaning.
export function Icon({
  icon,
  as,
  name,
  size = 18,
  strokeWidth = 1.4,
  label,
  className = "",
  ...rest
}) {
  const Component = icon || as || (name ? ICONS[name] || ICONS[toKey(name)] : null);
  if (!Component) {
    if (import.meta.env?.DEV && name) console.warn(`[ui] Icon "${name}" is not in ICONS`);
    return null;
  }
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <Component
      size={size}
      strokeWidth={strokeWidth}
      className={`ui-icon ${className}`.trim()}
      focusable="false"
      {...a11y}
      {...rest}
    />
  );
}

// Renders whatever was passed as an icon prop: an element, a component or a name.
export function renderIcon(icon, props = {}) {
  if (!icon) return null;
  if (typeof icon === "string") return <Icon name={icon} {...props} />;
  if (typeof icon === "function" || (typeof icon === "object" && icon.$$typeof && !icon.props))
    return <Icon icon={icon} {...props} />;
  return icon;
}

export function Spinner({ size = 16, label, className = "" }) {
  return (
    <span
      className={`ui-spinner ${className}`.trim()}
      style={{ "--spinner-size": `${size}px` }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

// Icon per media kind for file cards and lists.
export const MEDIA_ICONS = {
  image: FileImage,
  vector: PenTool,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  font: FileType,
  document: FileText,
  archive: FileArchive,
  design: Shapes,
  other: File,
};
