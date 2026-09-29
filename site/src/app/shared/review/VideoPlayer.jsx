import { useEffect, useRef, useState } from "react";
import { FileGlyph } from "../../ui/index.js";
import { cx, ratioOf, stageUrl } from "./util.js";
import "./review.css";

// Native player (controls, no autoplay) streamed through /api/files/:id/stream,
// which checks access on every range request. `poster` may be a URL or a cover
// File; without it the generated poster (or preview) is used. `active={false}`
// pauses the video (e.g. a carousel slide that left the screen).
export function VideoPlayer({ file, poster, active = true, className, label }) {
  const ref = useRef(null);
  const [failed, setFailed] = useState(false);
  const src = file?.previews?.stream;
  const posterUrl =
    (typeof poster === "string" ? poster : stageUrl(poster)) ||
    file?.previews?.poster ||
    file?.previews?.preview ||
    undefined;
  const ratio = ratioOf(file, 16 / 9);

  useEffect(() => {
    if (!active) ref.current?.pause?.();
  }, [active]);
  useEffect(() => setFailed(false), [src]);

  if (!file) return null;
  if (!src)
    return (
      <div className={cx("rv-video rv-video--empty", className)} style={{ "--ratio": ratio }}>
        <FileGlyph kind="video" format={file.format} name={file.name} status={file.previewStatus} />
      </div>
    );

  return (
    <div className={cx("rv-video", className)} style={{ "--ratio": ratio }}>
      <video
        ref={ref}
        controls
        preload="metadata"
        playsInline
        poster={posterUrl}
        src={src}
        aria-label={label || `Vídeo ${file.name}`}
        onError={() => setFailed(true)}
        controlsList="nodownload"
      />
      {failed && (
        <p className="rv-video__error" role="alert">
          Não foi possível reproduzir este vídeo aqui. Baixe o arquivo original para assistir.
        </p>
      )}
    </div>
  );
}

export default VideoPlayer;
