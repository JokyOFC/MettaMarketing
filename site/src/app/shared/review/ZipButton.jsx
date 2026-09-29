import { useState } from "react";
import { Download } from "lucide-react";
import { Button, Spinner } from "../../ui/index.js";
import { isActiveJob, useDownloads } from "../../api/downloads.js";
import { cx } from "./util.js";
import "./review.css";

// A "Baixar … (ZIP)" button that follows the real progress of the job it
// started ("Preparando ZIP… 40%"), so it never looks idle while the tray works.
// run() starts the job and resolves to the tray entry ({id, …}) or null.
// The label stays readable (no hidden-text spinner); clicks are ignored while
// the job runs. The tray keeps announcing "pronto"/"falhou" for screen readers.
export function ZipButton({ run, children, className, ...rest }) {
  const { jobs } = useDownloads();
  const [jobId, setJobId] = useState(null);
  const [starting, setStarting] = useState(false);
  const job = jobId ? jobs?.find((entry) => entry.id === jobId) : null;
  const active = starting || (job ? isActiveJob(job) : false);
  const percent = job && typeof job.progress === "number" && job.progress > 0 ? Math.round(job.progress * 100) : null;

  const start = async () => {
    if (active) return;
    setStarting(true);
    try {
      const entry = await run();
      if (entry?.id) setJobId(entry.id);
    } finally {
      setStarting(false);
    }
  };

  return (
    <Button
      {...rest}
      icon={active ? <Spinner size={14} /> : Download}
      className={cx("rv-zipbtn", active && "is-working", className)}
      aria-disabled={active || undefined}
      aria-busy={active || undefined}
      onClick={start}
    >
      {active ? (
        <>
          Preparando ZIP…{percent !== null && <span className="ui-num"> {percent}%</span>}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

export default ZipButton;
