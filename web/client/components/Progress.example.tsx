import { useEffect, useState } from "react";
import { Example } from "@floot/examples";
import { Progress } from "./Progress";

function AnimatedProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setProgress((prev) => (prev >= 100 ? 0 : prev + 10));
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  return <Progress value={progress} />;
}

export default function ProgressShowcase() {
  return (
    <>
      <h1>Progress</h1>
      <p>
        A horizontal bar showing how far a task has advanced. It fills the
        width it is given; <code>value</code> is a percentage from 0 to 100.
      </p>

      <h2>Values</h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "flex-start",
        }}
      >
        <Example title="Partial" width={320}>
          <Progress value={33} />
        </Example>

        <Example title="Empty" width={320}>
          <Progress value={0} />
        </Example>

        <Example title="Complete" width={320}>
          <Progress value={100} />
        </Example>
      </div>

      <h2>Animated</h2>
      <Example
        title="Ticking"
        description="Advances by ten percent every second, then restarts."
        width={320}
      >
        <AnimatedProgress />
      </Example>
    </>
  );
}
