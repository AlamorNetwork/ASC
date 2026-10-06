import { useState } from "react";
import { Example, Stage } from "@floot/examples";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";

const fieldColumn = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--spacing-2)",
} as const;

const labelStyle = { fontSize: "0.875rem", fontWeight: 500 } as const;

function EditProfileDialog({ container }: { container: HTMLElement | null }) {
  const [name, setName] = useState("Jane Doe");
  const [email, setEmail] = useState("jane.doe@example.com");

  return (
    <Dialog open modal={false}>
      <DialogContent container={container}>
        <DialogHeader>
          <DialogTitle>Edit Profile</DialogTitle>
          <DialogDescription>
            Update your profile information below. Click Save when you're done
            to apply the changes to your account.
          </DialogDescription>
        </DialogHeader>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-4)",
          }}
        >
          <div style={fieldColumn}>
            <label htmlFor="profile-name" style={labelStyle}>
              Full Name
            </label>
            <Input
              id="profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your full name"
            />
          </div>
          <div style={fieldColumn}>
            <label htmlFor="profile-email" style={labelStyle}>
              Email Address
            </label>
            <Input
              id="profile-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email"
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DialogShowcase() {
  return (
    <>
      <h1>Dialog</h1>
      <p>
        A window layered over the page for a focused task or confirmation. It
        dims the page behind it, traps focus, and closes on{" "}
        <code>Escape</code> or the corner button.
      </p>
      <p>
        <code>DialogHeader</code>, <code>DialogFooter</code> and the
        title/description parts are optional slots - the content below is the
        same component with and without a body between them.
      </p>

      <h2>Examples</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
        <Example
          title="Basic"
          description="Title, description and a pair of footer actions"
        >
          <Stage height={420}>
            {(container) => (
              <Dialog open modal={false}>
                <DialogContent container={container}>
                  <DialogHeader>
                    <DialogTitle>Basic Dialog</DialogTitle>
                    <DialogDescription>
                      This is a basic dialog with a title, description, and
                      footer buttons.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="secondary">Cancel</Button>
                    <Button>Confirm</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </Stage>
        </Example>

        <Example
          title="Edit profile"
          description="Form fields between the header and the footer"
        >
          <Stage height={520}>
            {(container) => <EditProfileDialog container={container} />}
          </Stage>
        </Example>
      </div>
    </>
  );
}
