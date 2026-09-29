// Brand typefaces: family, role, weights, usage and the files the license allows.
import { ExternalLink, Lock } from "lucide-react";
import { Button } from "../../ui/index.js";
import { safeUrl, splitList } from "./lib.js";
import { FileList, RichText } from "./parts.jsx";

const ICON = { strokeWidth: 1.4, "aria-hidden": true };

function FontCard({ font, index }) {
  const weights = splitList(font.weights);
  const source = safeUrl(font.sourceUrl);
  const allowed = font.distribution === "allowed";
  const files = (font.files || []).filter((f) => f.role !== "cover");
  return (
    <li className="mb-font ui-enter" style={{ "--i": Math.min(index, 8) }}>
      <div className="mb-font__head">
        {font.role && <p className="ui-eyebrow">{font.role}</p>}
        <h3 className="mb-font__family">{font.family}</h3>
        {weights.length > 0 && (
          <ul className="mb-font__weights" aria-label="Pesos">
            {weights.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="mb-font__body">
        {font.usage && <RichText text={font.usage} className="mb-font__usage" />}
        <div className="mb-font__files">
          {allowed ? (
            <>
              {files.length > 0 && (
                <FileList files={files} label={`Arquivos da fonte ${font.family}`} />
              )}
              {source && (
                <Button
                  variant={files.length ? "link" : "secondary"}
                  size="sm"
                  href={source}
                  target="_blank"
                  rel="noopener noreferrer"
                  iconRight={ExternalLink}
                >
                  {files.length ? "Página oficial da fonte" : "Obter no site oficial"}
                </Button>
              )}
            </>
          ) : (
            <div className="mb-license">
              <p className="mb-note">
                <Lock size={16} {...ICON} />
                <span>A licença desta fonte não permite distribuir os arquivos.</span>
              </p>
              {source ? (
                <Button
                  size="sm"
                  href={source}
                  target="_blank"
                  rel="noopener noreferrer"
                  iconRight={ExternalLink}
                >
                  Adquirir no site oficial
                </Button>
              ) : (
                <p className="mb-muted">Peça à equipe Metta o link oficial de aquisição.</p>
              )}
            </div>
          )}
          {font.license && <p className="mb-font__license">Licença: {font.license}</p>}
        </div>
      </div>
    </li>
  );
}

export default function Typography({ fonts, guidelines }) {
  return (
    <>
      {fonts.length > 0 && (
        <ul className="mb-fonts" aria-label="Tipografias">
          {fonts.map((font, i) => (
            <FontCard key={font.id || font.family} font={font} index={i} />
          ))}
        </ul>
      )}
      {guidelines && (
        <div className="mb-guide mb-guide--type">
          <p className="mb-label">Orientações tipográficas</p>
          <RichText text={guidelines} />
        </div>
      )}
    </>
  );
}
