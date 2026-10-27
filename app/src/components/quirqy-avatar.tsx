
import { useState } from "react";
import { Blobatar } from "@blobatar/react";
import { useGaze } from "@blobatar/react/gaze";
import { happy, idle, thinking, unsure, wink } from "blobatar/expression";

export function QuirqyAvatar({ pending, drafting, replied }: { pending: boolean; drafting: boolean; replied: boolean }) {
  const [variant, setVariant] = useState(0);
  const [engaged, setEngaged] = useState(false);
  const { ref } = useGaze({ travel: 4, lookAt: "pointer" });
  const mood = pending ? "thinking" : engaged ? "wink" : drafting ? "curious" : replied ? "happy" : "idle";
  const expression = { thinking, wink, curious: unsure, happy, idle }[mood];

  return <button
    type="button"
    className="quirqy-avatar"
    aria-label="Change quirqy's avatar"
    title="Click for a new look"
    data-mood={mood}
    data-variant={variant}
    onClick={() => setVariant(value => value + 1)}
    onPointerEnter={() => setEngaged(true)}
    onPointerLeave={() => setEngaged(false)}
    onFocus={() => setEngaged(true)}
    onBlur={() => setEngaged(false)}
  >
    <Blobatar ref={ref} name={variant ? "quirqy-" + variant : "quirqy"} size={64} animate="always" expression={expression} aria-hidden="true" />
  </button>;
}
