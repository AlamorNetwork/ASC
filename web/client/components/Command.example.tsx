import { useState } from "react";
import {
  Calculator,
  Calendar,
  CreditCard,
  Settings,
  Smile,
  User,
} from "lucide-react";
import { Example } from "@floot/examples";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./Command";
import { Button } from "./Button";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover";

function CommandMenuDialog() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>Open Command Menu</Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Type a command or search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Suggestions">
            <CommandItem>
              <Calendar />
              <span>Calendar</span>
              <CommandShortcut>?C</CommandShortcut>
            </CommandItem>
            <CommandItem>
              <Smile />
              <span>Search Emoji</span>
              <CommandShortcut>?E</CommandShortcut>
            </CommandItem>
            <CommandItem>
              <Calculator />
              <span>Calculator</span>
              <CommandShortcut>?K</CommandShortcut>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Settings">
            <CommandItem>
              <User />
              <span>Profile</span>
              <CommandShortcut>?P</CommandShortcut>
            </CommandItem>
            <CommandItem>
              <CreditCard />
              <span>Billing</span>
              <CommandShortcut>?B</CommandShortcut>
            </CommandItem>
            <CommandItem>
              <Settings />
              <span>Settings</span>
              <CommandShortcut>?S</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}

const frameworks = ["React", "Vue", "Angular", "Svelte"];

function CommandCombobox() {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState("");

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <Button variant="outline">
          {selected ? selected : "Select a framework"}
        </Button>
      </PopoverTrigger>
      <PopoverContent removeBackgroundAndPadding side="bottom" align="start">
        <Command>
          <CommandInput placeholder="Search framework..." />
          <CommandList>
            <CommandEmpty>No frameworks found.</CommandEmpty>
            <CommandGroup>
              {frameworks.map((framework) => (
                <CommandItem
                  key={framework}
                  onSelect={() => {
                    setSelected(framework);
                    setOpen(false);
                  }}
                >
                  {framework}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default function CommandShowcase() {
  return (
    <>
      <h1>Command</h1>
      <p>
        A filterable list of commands or options, driven by a search input. It
        can sit in a dialog as a command palette or inside a popover as a
        combobox.
      </p>

      <h2>Examples</h2>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          alignItems: "flex-start",
        }}
      >
        <Example title="Command palette" width={520}>
          <CommandMenuDialog />
        </Example>

        <Example title="Combobox" width={520}>
          <div style={{ minHeight: 270 }}>
            <CommandCombobox />
          </div>
        </Example>
      </div>
    </>
  );
}
