import { lazy } from "react";
import { Navigate, Route } from "react-router-dom";
import {
  ForgotPasswordPage,
  InvitePage,
  LoginPage,
  ResetPasswordPage,
  SignupPage,
} from "../pages/AuthPages.jsx";
import RequireAuth from "./auth/RequireAuth.jsx";
import AppShell from "./shell/AppShell.jsx";
import { ProductNotFound } from "./shell/ShellStates.jsx";
import * as P from "./pages.js";

// Dev-only visual kit gallery; the branch is dropped from production builds.
// A glob keeps the route optional while the file does not exist.
const galleryModules = import.meta.env.DEV ? import.meta.glob("./ui/Gallery.jsx") : {};
const loadGallery = galleryModules["./ui/Gallery.jsx"];
const Gallery = loadGallery ? lazy(loadGallery) : null;

// Capability gate inside the shell (string or any-of array).
const gate = (cap, element) => <RequireAuth cap={cap}>{element}</RequireAuth>;

export const productRoutes = (
  <>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/cadastro" element={<SignupPage />} />
    <Route path="/registro" element={<Navigate to="/cadastro" replace />} />
    <Route path="/convite/:token" element={<InvitePage />} />
    <Route path="/recuperar-senha" element={<ForgotPasswordPage />} />
    <Route path="/redefinir-senha/:token" element={<ResetPasswordPage />} />

    <Route
      path="/painel"
      element={
        <RequireAuth area="client">
          <AppShell area="client" />
        </RequireAuth>
      }
    >
      <Route index element={<P.ClientOverview />} />
      <Route path="marca" element={<P.BrandLibrary />} />
      <Route path="arquivos" element={<P.ClientFiles />} />
      <Route path="conteudo" element={<P.ContentHub />} />
      <Route path="conteudo/:id" element={<P.ContentDetail />} />
      <Route path="projetos" element={<P.ClientProjects />} />
      <Route path="briefings" element={<P.ClientBriefings />} />
      <Route path="briefings/:id" element={<P.BriefingForm />} />
      <Route path="financeiro" element={<P.ClientBilling />} />
      <Route path="notificacoes" element={<P.ClientNotifications />} />
      <Route path="historico" element={<P.ClientHistory />} />
      <Route path="conta" element={<P.Account />} />
      <Route path="*" element={<ProductNotFound />} />
    </Route>

    <Route
      path="/admin"
      element={
        <RequireAuth area="admin">
          <AppShell area="admin" />
        </RequireAuth>
      }
    >
      <Route index element={<P.AdminOverview />} />
      <Route path="clientes" element={gate("clients.view", <P.ClientsList />)} />
      <Route path="clientes/:id" element={gate("clients.view", <P.ClientDetail />)} />
      <Route path="equipe" element={gate("team.view", <P.Team />)} />
      <Route path="planos" element={gate("services.view", <P.Services />)} />
      <Route path="pedidos" element={gate("orders.view", <P.Orders />)} />
      <Route path="financeiro" element={gate("finance.view", <P.Finance />)} />
      <Route path="briefings" element={gate("briefings.view", <P.Briefings />)} />
      <Route path="briefings/:id" element={gate("briefings.view", <P.BriefingEditor />)} />
      <Route path="projetos" element={gate("projects.view", <P.Projects />)} />
      <Route path="projetos/:id" element={gate("projects.view", <P.ProjectDetail />)} />
      <Route path="biblioteca" element={gate("materials.view", <P.Library />)} />
      <Route path="biblioteca/enviar" element={gate("materials.upload", <P.UploadFlow />)} />
      <Route path="biblioteca/:id" element={gate("materials.view", <P.MaterialAdmin />)} />
      <Route path="marcas/:id" element={gate("materials.view", <P.BrandIdentity />)} />
      <Route path="kits" element={gate("materials.view", <P.Kits />)} />
      <Route path="conteudo" element={gate("content.view", <P.AdminContent />)} />
      <Route path="conteudo/novo" element={gate("content.manage", <P.PostEditor />)} />
      <Route path="conteudo/:id" element={gate("content.view", <P.AdminPostDetail />)} />
      <Route path="aprovacoes" element={gate("approvals.view", <P.Approvals />)} />
      <Route
        path="relatorios"
        element={gate(["reports.view", "reports.finance"], <P.Reports />)}
      />
      <Route path="notificacoes" element={<P.AdminNotifications />} />
      <Route
        path="configuracoes"
        element={gate(["settings.manage", "categories.manage"], <P.Settings />)}
      />
      <Route path="historico" element={gate("activity.view", <P.ActivityLog />)} />
      <Route path="conta" element={<P.Account />} />
      {Gallery && <Route path="ui" element={<Gallery />} />}
      <Route path="*" element={<ProductNotFound />} />
    </Route>
  </>
);
