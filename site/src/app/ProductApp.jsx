import { Route, Routes } from "react-router-dom";
import { NotFoundPage } from "../pages/MarketingPages.jsx";
import { AuthProvider } from "./auth/AuthProvider.jsx";
import { productRoutes } from "./routes.jsx";

// Entry of the product bundle (access pages, client area, Metta panel).
// App.jsx loads it lazily, so marketing visitors never download it.
export default function ProductApp({ location }) {
  return (
    <AuthProvider>
      <Routes location={location}>
        {productRoutes}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}

export { productRoutes };
