import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, RotateCcw } from "lucide-react";
import { publicPath } from "./site";

/** One bounded camera move; pause offscreen, in hidden tabs, or by user choice. */
function useCinematic() {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [foreground, setForeground] = useState(!document.hidden);
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [paused, setPaused] = useState(false);
  const [complete, setComplete] = useState(false);
  const [take, setTake] = useState(0);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.25 },
    );
    if (root.current) observer.observe(root.current);
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const preference = () => setReduced(media.matches);
    const visibility = () => setForeground(!document.hidden);
    media.addEventListener("change", preference);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", preference);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  return {
    root,
    take,
    reduced,
    complete,
    paused,
    playing: visible && foreground && !reduced && !paused && !complete,
    finish: () => setComplete(true),
    toggle: () => {
      if (complete) {
        setTake((value) => value + 1);
        setComplete(false);
        setPaused(false);
      } else setPaused((value) => !value);
    },
  };
}

export default function CinematicScene({
  image,
  alt,
  kind,
  children,
}: {
  image: string;
  alt: string;
  kind: string;
  children: ReactNode;
}) {
  const motion = useCinematic();
  const [ready, setReady] = useState(false);
  return (
    <div
      className="model-image cinematic-scene"
      ref={motion.root}
      data-playing={motion.playing && ready}
      data-complete={motion.complete}
      data-reduced={motion.reduced}
      data-scene={kind}
    >
      <div className="scene-viewport">
        <div
          className="scene-camera"
          key={motion.take}
          onAnimationEnd={(event) => {
            if (event.animationName === "scene-camera") motion.finish();
          }}
        >
          <img
            src={publicPath(`/images/world/${image}.webp`)}
            srcSet={
              image === "pointcloud"
                ? undefined
                : `${publicPath(`/images/world/${image}-600.webp`)} 600w, ${publicPath(`/images/world/${image}.webp`)} 1200w`
            }
            sizes="(max-width: 760px) 90vw, 50vw"
            width="1200"
            height="800"
            loading="lazy"
            decoding="async"
            alt={alt}
            onLoad={() => setReady(true)}
          />
        </div>
        <div
          className="scene-scan"
          key={`scan-${motion.take}`}
          aria-hidden="true"
        />
        <span className="scene-caption">Illustrative scene</span>
        {!motion.reduced && (
          <button
            className="scene-motion"
            onClick={motion.toggle}
            aria-label={
              motion.complete
                ? "Replay cinematic scene"
                : motion.paused
                  ? "Resume cinematic scene"
                  : "Pause cinematic scene"
            }
          >
            {motion.complete || motion.paused ? (
              <RotateCcw size={14} />
            ) : (
              <Pause size={14} />
            )}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

export function HistorySequence({
  frames,
}: {
  frames: readonly { time: string; label: string }[];
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const motion = useCinematic();
  return (
    <div
      className="history-cinema"
      ref={motion.root}
      data-playing={motion.playing}
      data-reduced={motion.reduced}
    >
      <div
        className={`history-frames ${selected !== null ? "has-selection" : ""}`}
      >
        <span className="example-caption">Example data</span>
        {frames.map((frame, index) => (
          <figure
            key={frame.time}
            className={selected === index ? "selected" : ""}
          >
            <button
              className="history-moment"
              aria-label={`Inspect ${frame.time}: ${frame.label}`}
              aria-pressed={selected === index}
              onClick={() => setSelected(selected === index ? null : index)}
            >
              <img
                src={publicPath(`/images/world/${frame.time}.webp`)}
                width="1200"
                height="800"
                loading="lazy"
                alt={frame.label}
              />
              <span className="history-focus" aria-hidden="true">
                {selected === index ? "Show all moments" : "Inspect moment"}
              </span>
            </button>
            <figcaption>
              <span>{frame.time}</span>
              {frame.label}
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="history-track" aria-hidden="true">
        <span />
      </div>
    </div>
  );
}
