import { Example } from "@floot/examples";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./Accordion";

export default function AccordionShowcase() {
  return (
    <>
      <h1>Accordion</h1>
      <p>
        A vertically stacked set of headings that each reveal a section of
        content.
      </p>

      <h2>Usage</h2>
      <Example title="Collapsible" width={560}>
        <Accordion type="single" collapsible>
          <AccordionItem value="item-1">
            <AccordionTrigger>What is an accordion?</AccordionTrigger>
            <AccordionContent>
              An accordion is a vertically stacked set of interactive headings
              that each reveal a section of content.
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Example>

      <Example title="Multiple items" width={560}>
        <Accordion type="single">
          <AccordionItem value="item-1">
            <AccordionTrigger>First Section</AccordionTrigger>
            <AccordionContent>
              This is the first section's content. Multiple sections can be open
              at once.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-2">
            <AccordionTrigger>Second Section</AccordionTrigger>
            <AccordionContent>
              This is the second section's content. Try opening both sections at
              the same time.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-3">
            <AccordionTrigger>Third Section</AccordionTrigger>
            <AccordionContent>
              This is the third section's content. The animation is smooth and
              natural.
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Example>

      <h2>States</h2>
      <Example title="Disabled item" width={560}>
        <Accordion type="single">
          <AccordionItem value="item-1">
            <AccordionTrigger>Available Section</AccordionTrigger>
            <AccordionContent>
              This section can be expanded and collapsed.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-2">
            <AccordionTrigger disabled>Disabled Section</AccordionTrigger>
            <AccordionContent>
              This content won't be accessible.
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Example>
    </>
  );
}
