import { Example } from "@floot/examples";
import { Skeleton } from "./Skeleton";

export default function SkeletonShowcase() {
  return (
    <>
      <h1>Skeleton</h1>
      <p>
        A placeholder block that stands in for content while it is loading. Size
        and shape come from the <code>style</code> or <code>className</code> you
        pass.
      </p>

      <h2>Usage</h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "flex-start",
        }}
      >
        <Example title="Text lines">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--spacing-sm)",
            }}
          >
            <Skeleton style={{ width: "200px", height: "2rem" }} />
            <Skeleton style={{ width: "160px", height: "1rem" }} />
            <Skeleton style={{ width: "180px", height: "1rem" }} />
          </div>
        </Example>

        <Example title="Profile">
          <div
            style={{
              display: "flex",
              gap: "var(--spacing-sm)",
              alignItems: "center",
            }}
          >
            <Skeleton
              style={{ width: "4rem", height: "4rem", borderRadius: "50%" }}
            />
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--spacing-xs)",
              }}
            >
              <Skeleton style={{ width: "150px", height: "1.5rem" }} />
              <Skeleton style={{ width: "100px", height: "1rem" }} />
            </div>
          </div>
        </Example>
      </div>
    </>
  );
}
