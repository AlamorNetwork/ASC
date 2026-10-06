import { Example } from "@floot/examples";
import { Spinner } from "./Spinner";

export default function SpinnerShowcase() {
  return (
    <>
      <h1>Spinner</h1>
      <p>An indeterminate loading indicator for work with no known duration.</p>

      <h2>Sizes</h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "flex-start",
        }}
      >
        <Example title="Small">
          <Spinner size="sm" />
        </Example>

        <Example title="Medium">
          <Spinner size="md" />
        </Example>

        <Example title="Large">
          <Spinner size="lg" />
        </Example>
      </div>

      <h2>In context</h2>
      <Example title="Loading label">
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.25rem 0.75rem",
            background: "var(--color-gray-200)",
            borderRadius: "var(--radius-md)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          <Spinner size="sm" />
          Loading...
        </div>
      </Example>
    </>
  );
}
