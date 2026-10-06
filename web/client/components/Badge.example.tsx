import { Example } from "@floot/examples";
import { Badge } from "./Badge";

export default function BadgeShowcase() {
  return (
    <>
      <h1>Badge</h1>
      <p>A small inline label for status, category, or count.</p>

      <h2>Variants</h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "flex-start",
        }}
      >
        <Example title="Primary">
          <Badge>Active</Badge>
        </Example>

        <Example title="Secondary">
          <Badge variant="secondary">Premium</Badge>
        </Example>

        <Example title="Outline">
          <Badge variant="outline">Draft</Badge>
        </Example>

        <Example title="Destructive">
          <Badge variant="destructive">Expired</Badge>
        </Example>

        <Example title="Success">
          <Badge variant="success">Completed</Badge>
        </Example>

        <Example title="Warning">
          <Badge variant="warning">Caution</Badge>
        </Example>
      </div>
    </>
  );
}
