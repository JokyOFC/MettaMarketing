import { CopyButton, formatNumber } from "../../ui/index.js";
import { cx, parseHashtags } from "./util.js";
import "./review.css";

// Caption and hashtags of a post, each with its own copy button and the
// kit's "Copiado" feedback; a third button copies both, ready to paste.
export function CaptionBlock({ caption, hashtags, title = "Legenda", className, emptyText }) {
  const text = String(caption ?? "").trim();
  const tags = parseHashtags(hashtags);
  const tagText = tags.join(" ");
  const full = [text, tagText].filter(Boolean).join("\n\n");

  if (!text && !tags.length)
    return (
      <div className={cx("rv-caption rv-caption--empty", className)}>
        <h3 className="rv-caption__title">{title}</h3>
        <p className="rv-caption__none">{emptyText ?? "Esta versão não tem legenda nem hashtags."}</p>
      </div>
    );

  return (
    <div className={cx("rv-caption", className)}>
      <div className="rv-caption__head">
        <h3 className="rv-caption__title">{title}</h3>
        {text && <span className="rv-caption__count ui-num">{formatNumber(text.length)} caracteres</span>}
      </div>
      {text && (
        <div className="rv-caption__block">
          <p className="rv-caption__text">{text}</p>
          <CopyButton text={text} label="Copiar legenda" className="rv-caption__copy" />
        </div>
      )}
      {tags.length > 0 && (
        <div className="rv-caption__block rv-caption__block--tags">
          <ul className="rv-caption__tags" aria-label="Hashtags">
            {tags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
          <CopyButton text={tagText} label="Copiar hashtags" className="rv-caption__copy" />
        </div>
      )}
      {text && tags.length > 0 && (
        <CopyButton text={full} label="Copiar legenda com hashtags" variant="secondary" className="rv-caption__all" />
      )}
    </div>
  );
}

export default CaptionBlock;
