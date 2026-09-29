import { useState } from "react";
import { whatsappUrl, whatsappNumber } from "../data/brand.js";
export function WhatsAppLink() {
  return (
    <a
      className="whatsapp-link"
      href={whatsappUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Falar pelo WhatsApp: ${whatsappNumber}`}
    >
      <svg
        viewBox="0 0 24 24"
        width="23"
        height="23"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M20.52 3.48A11.91 11.91 0 0 0 12.04 0C5.47 0 .12 5.35.12 11.93c0 2.1.55 4.16 1.6 5.98L.02 24l6.26-1.64a11.9 11.9 0 0 0 5.75 1.46h.01c6.58 0 11.93-5.35 11.93-11.93a11.85 11.85 0 0 0-3.45-8.41ZM12.04 21.8a9.9 9.9 0 0 1-5.05-1.38l-.36-.21-3.72.98.99-3.63-.23-.37a9.89 9.89 0 0 1-1.52-5.26c0-5.46 4.44-9.9 9.9-9.9a9.82 9.82 0 0 1 7 2.9 9.83 9.83 0 0 1 2.9 7c0 5.45-4.44 9.88-9.91 9.88Zm5.43-7.4c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.64.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.44-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.92-2.21-.24-.58-.48-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.48 1.69.62.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2-1.42.25-.7.25-1.29.18-1.42-.08-.12-.28-.2-.57-.35Z" />
      </svg>
      <span>{whatsappNumber}</span>
    </a>
  );
}
export function PurchaseButton({ identity = false }) {
  const [notice, setNotice] = useState(false);
  return (
    <>
      <button type="button" className="button" onClick={() => setNotice(true)}>
        {identity ? "Comprar identidade visual" : "Comprar este plano"}
        <span aria-hidden="true">↗</span>
      </button>
      {notice && (
        <p className="purchase-notice" role="status">
          A compra online estará disponível em breve.
        </p>
      )}
    </>
  );
}
export function IdentityBanner() {
  return (
    <aside
      className="identity-banner"
      aria-label="Identidade visual por R$ 2.000"
    >
      <div>
        <span className="identity-label">IDENTIDADE VISUAL</span>
        <h3>
          Tenha sua identidade visual
          <br />
          <em>por R$ 2.000.</em>
        </h3>
      </div>
      <div className="identity-action">
        <PurchaseButton identity />
      </div>
    </aside>
  );
}
