// Every product page, loaded on demand so each area only downloads what it
// opens. Slices replace the files behind these imports, keeping the paths and
// the default exports (see docs/FRONTEND.md).
import { lazy } from "react";

// Client area (/painel)
export const ClientOverview = lazy(() => import("./client/overview/ClientOverview.jsx"));
export const BrandLibrary = lazy(() => import("./client/brand/BrandLibrary.jsx"));
export const ClientFiles = lazy(() => import("./client/files/ClientFiles.jsx"));
export const ContentHub = lazy(() => import("./client/content/ContentHub.jsx"));
export const ContentDetail = lazy(() => import("./client/content/ContentDetail.jsx"));
export const ClientProjects = lazy(() => import("./client/projects/ClientProjects.jsx"));
export const ClientBriefings = lazy(() => import("./client/briefings/ClientBriefings.jsx"));
export const BriefingForm = lazy(() => import("./client/briefings/BriefingForm.jsx"));
export const ClientBilling = lazy(() => import("./client/billing/ClientBilling.jsx"));
export const Purchase = lazy(() => import("./client/purchase/Purchase.jsx"));
export const ClientNotifications = lazy(() => import("./client/notifications/ClientNotifications.jsx"));
export const ClientHistory = lazy(() => import("./client/history/ClientHistory.jsx"));
export const Account = lazy(() => import("./client/account/Account.jsx"));

// Metta panel (/admin)
export const AdminOverview = lazy(() => import("./admin/overview/AdminOverview.jsx"));
export const ClientsList = lazy(() => import("./admin/clients/ClientsList.jsx"));
export const ClientDetail = lazy(() => import("./admin/clients/ClientDetail.jsx"));
export const Team = lazy(() => import("./admin/team/Team.jsx"));
export const Services = lazy(() => import("./admin/services/Services.jsx"));
export const Orders = lazy(() => import("./admin/orders/Orders.jsx"));
export const Finance = lazy(() => import("./admin/finance/Finance.jsx"));
export const Briefings = lazy(() => import("./admin/briefings/Briefings.jsx"));
export const BriefingEditor = lazy(() => import("./admin/briefings/BriefingEditor.jsx"));
export const Projects = lazy(() => import("./admin/projects/Projects.jsx"));
export const ProjectDetail = lazy(() => import("./admin/projects/ProjectDetail.jsx"));
export const Library = lazy(() => import("./admin/library/Library.jsx"));
export const UploadFlow = lazy(() => import("./admin/library/UploadFlow.jsx"));
export const MaterialAdmin = lazy(() => import("./admin/library/MaterialAdmin.jsx"));
export const BrandIdentity = lazy(() => import("./admin/library/BrandIdentity.jsx"));
export const Kits = lazy(() => import("./admin/library/Kits.jsx"));
export const AdminContent = lazy(() => import("./admin/content/AdminContent.jsx"));
export const PostEditor = lazy(() => import("./admin/content/PostEditor.jsx"));
export const AdminPostDetail = lazy(() => import("./admin/content/AdminPostDetail.jsx"));
export const Approvals = lazy(() => import("./admin/approvals/Approvals.jsx"));
export const Reports = lazy(() => import("./admin/reports/Reports.jsx"));
export const AdminNotifications = lazy(() => import("./admin/notifications/AdminNotifications.jsx"));
export const Settings = lazy(() => import("./admin/settings/Settings.jsx"));
export const ActivityLog = lazy(() => import("./admin/activity/ActivityLog.jsx"));
