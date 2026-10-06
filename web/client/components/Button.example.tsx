import { Example } from "@floot/examples";
import { Button } from "./Button";
import { StarIcon, SendIcon, TrashIcon, PlusIcon, MenuIcon } from "lucide-react";

const row = {
  display: "flex",
  flexWrap: "wrap",
  gap: "1rem",
  alignItems: "flex-start",
} as const;

export default function ButtonShowcase() {
  return (
    <>
      <h1>Button</h1>
      <p>A clickable control that triggers an action, available in several visual variants and sizes.</p>

      <h2>Variants</h2>
      <div style={row}>
        <Example title="Primary">
          <Button>Primary</Button>
        </Example>
        <Example title="Secondary">
          <Button variant="secondary">Secondary</Button>
        </Example>
        <Example title="Outline">
          <Button variant="outline">Outline</Button>
        </Example>
        <Example title="Ghost">
          <Button variant="ghost">Ghost</Button>
        </Example>
        <Example title="Link">
          <Button variant="link">Link</Button>
        </Example>
        <Example title="Destructive">
          <Button variant="destructive">Destructive</Button>
        </Example>
      </div>

      <h2>Sizes</h2>
      <div style={row}>
        <Example title="Small">
          <Button size="sm">Small</Button>
        </Example>
        <Example title="Medium">
          <Button size="md">Medium</Button>
        </Example>
        <Example title="Large">
          <Button size="lg">Large</Button>
        </Example>
      </div>

      <h2>Icon buttons</h2>
      <div style={row}>
        <Example title="Icon small">
          <Button size="icon-sm">
            <StarIcon size={14} />
          </Button>
        </Example>
        <Example title="Icon medium">
          <Button size="icon-md">
            <SendIcon size={16} />
          </Button>
        </Example>
        <Example title="Icon large">
          <Button size="icon-lg">
            <PlusIcon size={20} />
          </Button>
        </Example>
        <Example title="Icon outline">
          <Button variant="outline" size="icon-md">
            <MenuIcon size={16} />
          </Button>
        </Example>
        <Example title="Icon destructive">
          <Button variant="destructive" size="icon-md">
            <TrashIcon size={16} />
          </Button>
        </Example>
      </div>

      <h2>With icons</h2>
      <div style={row}>
        <Example title="Star">
          <Button>
            <StarIcon size={16} /> Star
          </Button>
        </Example>
        <Example title="Send">
          <Button variant="secondary">
            <SendIcon size={16} /> Send
          </Button>
        </Example>
        <Example title="Delete">
          <Button variant="destructive">
            <TrashIcon size={16} /> Delete
          </Button>
        </Example>
      </div>

      <h2>States</h2>
      <div style={row}>
        <Example title="Normal">
          <Button>Normal</Button>
        </Example>
        <Example title="Disabled">
          <Button disabled>Disabled</Button>
        </Example>
      </div>
    </>
  );
}
