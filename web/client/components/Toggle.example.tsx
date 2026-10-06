import { Example } from "@floot/examples";
import { Toggle } from "./Toggle";
import { Star, Bell, Heart } from "lucide-react";

const row = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1rem",
  alignItems: "flex-start",
} as const;

export default function ToggleShowcase() {
  return (
    <>
      <h1>Toggle</h1>
      <p>A two-state button that stays pressed while it is on.</p>

      <h2>Icon only</h2>
      <div style={row}>
        <Example title="Small icon">
          <Toggle size="sm">
            <Star size={14} />
          </Toggle>
        </Example>
        <Example title="Medium icon">
          <Toggle>
            <Bell size={16} />
          </Toggle>
        </Example>
        <Example title="Large icon">
          <Toggle size="lg">
            <Heart size={20} />
          </Toggle>
        </Example>
      </div>

      <h2>Text and icon</h2>
      <div style={row}>
        <Example title="Outline medium">
          <Toggle variant="outline">
            <Bell size={16} /> <span>Notifications</span>
          </Toggle>
        </Example>
        <Example title="Outline large">
          <Toggle size="lg" variant="outline">
            <Heart size={20} /> <span>Favorite</span>
          </Toggle>
        </Example>
      </div>

      <h2>Text only</h2>
      <div style={row}>
        <Example title="Small text">
          <Toggle size="sm">
            <span>Pin</span>
          </Toggle>
        </Example>
        <Example title="Medium text">
          <Toggle>
            <span>Default</span>
          </Toggle>
        </Example>
        <Example title="Large text">
          <Toggle size="lg">
            <span>Large</span>
          </Toggle>
        </Example>
      </div>
    </>
  );
}
