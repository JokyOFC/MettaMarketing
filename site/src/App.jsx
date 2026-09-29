import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import PageTransition from "./components/PageTransition.jsx";
import "./transitions.css";
import Home from "./Home.jsx";
import {
  AboutPage,
  SolutionsPage,
  MethodPage,
  PlansPage,
  ContactPage,
  NotFoundPage,
} from "./pages/MarketingPages.jsx";
import "./tokens.css";
import "./pages.css";

// Access pages, client area and Metta panel live in their own bundle.
const ProductApp = lazy(() => import("./app/ProductApp.jsx"));
const isProduct = (path) =>
  /^\/(login|cadastro|registro|convite|recuperar-senha|redefinir-senha|painel|admin)(\/|$)/.test(
    path,
  );
const ProductBoot = () => (
  <div style={{ minHeight: "100dvh", background: "var(--metta-paper)" }} />
);

export default function App() {
  return (
    <BrowserRouter>
      <PageTransition>
        {(location) =>
          isProduct(location.pathname) ? (
            <Suspense fallback={<ProductBoot />}>
              <ProductApp location={location} />
            </Suspense>
          ) : (
            <Routes location={location}>
              <Route path="/" element={<Home />} />
              <Route path="/sobre" element={<AboutPage />} />
              <Route path="/solucoes" element={<SolutionsPage />} />
              <Route path="/metodo" element={<MethodPage />} />
              <Route path="/planos" element={<PlansPage />} />
              <Route path="/contato" element={<ContactPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          )
        }
      </PageTransition>
    </BrowserRouter>
  );
}
