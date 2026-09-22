import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowRight,
  GitBranch,
  Layers3,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { publicPath } from "./site";

export const worldFrames = [
  { time: "t0", label: "Object observed", x: 47, y: 65 },
  { time: "t1", label: "Action recorded", x: 50, y: 53 },
  { time: "t2", label: "World updated", x: 56, y: 65 },
];
const phases = [
  "Observe",
  "Expand history",
  "Explore a branch",
  "Focus one moment",
];

/** Illustrative, read-only scene. No backend requests or world-state writes. */
export default function WorldTimeline() {
  const root = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [visible, setVisible] = useState(false);
  const [foreground, setForeground] = useState(!document.hidden);
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState(0);
  const [frame, setFrame] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [candidate, setCandidate] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.35 },
    );
    if (root.current) observer.observe(root.current);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const preference = () => {
      setReduced(motion.matches);
      if (motion.matches) setPlaying(false);
    };
    const visibility = () => setForeground(!document.hidden);
    motion.addEventListener("change", preference);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer.disconnect();
      motion.removeEventListener("change", preference);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (visible && ready && !started.current) {
      started.current = true;
      if (!reduced) {
        setFrame(0);
        setPlaying(true);
      }
    }
  }, [visible, ready, reduced]);
  useEffect(() => {
    if (!playing || !visible || !foreground || reduced) return;
    const timer = window.setTimeout(() => {
      if (step === 0) {
        setExpanded(true);
        setFrame(1);
      }
      if (step === 1) setCandidate(true);
      if (step === 2) {
        setCandidate(false);
        setExpanded(false);
        setFrame(1);
      }
      if (step >= 3) {
        setPlaying(false);
        return;
      }
      setStep((s) => s + 1);
    }, 1750);
    return () => window.clearTimeout(timer);
  }, [playing, visible, foreground, reduced, step]);
  const takeControl = () => {
    started.current = true;
    setPlaying(false);
    setCandidate(false);
  };
  const select = (index: number) => {
    takeControl();
    setFrame(Math.max(0, Math.min(2, index)));
  };
  const replay = () => {
    started.current = true;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (reduced) {
      setExpanded((e) => !e);
      return;
    }
    setStep(0);
    setFrame(0);
    setExpanded(false);
    setCandidate(false);
    setPlaying(true);
  };
  return (
    <div
      id="world-demo"
      ref={root}
      className={`world-timeline ${expanded ? "is-expanded" : "is-focused"} ${candidate ? "has-candidate" : ""}`}
      data-playing={playing}
      data-frame={frame}
    >
      <div
        className="world-depth"
        aria-label={`Illustrative world state, ${worldFrames[frame].label}`}
        role="img"
      >
        {worldFrames.map((item, index) => (
          <div
            key={item.time}
            className={`world-plane ${index === frame ? "is-current" : ""}`}
            style={
              {
                "--offset": index - frame,
                "--order": index,
                "--point-x": `${item.x}%`,
                "--point-y": `${item.y}%`,
              } as CSSProperties
            }
          >
            <img
              src={publicPath(`/images/world/${item.time}.webp`)}
              srcSet={
                index === 1
                  ? undefined
                  : `${publicPath(`/images/world/${item.time}-600.webp`)} 600w, ${publicPath(`/images/world/${item.time}.webp`)} 1200w`
              }
              sizes="(max-width: 760px) 76vw, 45vw"
              width="1200"
              height="800"
              alt=""
              fetchPriority={index === 1 ? "high" : "low"}
              decoding="async"
              onLoad={index === 1 ? () => setReady(true) : undefined}
            />
            <span className="world-frame-time">{item.time}</span>
            {index === frame && (
              <>
                <span className="world-frame-note">
                  Illustrative world state
                </span>
                <svg
                  viewBox="0 0 100 66.67"
                  className="world-overlay"
                  aria-hidden="true"
                >
                  <path
                    d={`M ${item.x} ${(item.y * 2) / 3} L ${item.x} 47 L 69 48 L 38 49 Z`}
                  />
                  {candidate && (
                    <path
                      className="candidate-route"
                      d={`M ${item.x} ${(item.y * 2) / 3} Q 62 26 74 42 L 75 49`}
                    />
                  )}
                  <circle cx={item.x} cy={(item.y * 2) / 3} r="0.45" />
                  <circle cx={item.x} cy="47" r="0.3" />
                  <circle cx="69" cy="48" r="0.3" />
                </svg>
              </>
            )}
          </div>
        ))}
        <div className="world-candidate" aria-hidden={!candidate}>
          <GitBranch size={13} /> Candidate · alternative action
        </div>
      </div>
      <div className="world-controls">
        <div className="world-time-labels" aria-hidden="true">
          {worldFrames.map((f, i) => (
            <span key={f.time} className={frame === i ? "selected" : ""}>
              {f.time}
            </span>
          ))}
        </div>
        <input
          className="world-range"
          type="range"
          min="0"
          max="2"
          step="1"
          value={frame}
          aria-label="World timeline"
          aria-valuetext={`${worldFrames[frame].time}: ${worldFrames[frame].label}`}
          onChange={(event) => select(Number(event.target.value))}
        />
        <div className="world-playback">
          <button
            className="ghost icon-button"
            aria-label="Previous moment"
            disabled={frame === 0}
            onClick={() => select(frame - 1)}
          >
            <SkipBack size={14} />
          </button>
          <button
            className="world-play"
            aria-label={
              playing
                ? "Pause world animation"
                : reduced
                  ? "Toggle world history"
                  : "Replay world animation"
            }
            onClick={replay}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button
            className="ghost icon-button"
            aria-label="Next moment"
            disabled={frame === 2}
            onClick={() => select(frame + 1)}
          >
            <SkipForward size={14} />
          </button>
          <button
            className="world-expand ghost"
            aria-expanded={expanded}
            onClick={() => {
              takeControl();
              setExpanded((value) => !value);
            }}
          >
            <Layers3 size={15} />{" "}
            {expanded ? "Focus this moment" : "Expand timeline"}
            <ArrowRight size={14} />
          </button>
        </div>
        <span className="world-phase" aria-live="off">
          {playing ? phases[step] : worldFrames[frame].label}
        </span>
      </div>
    </div>
  );
}
