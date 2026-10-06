import { useState } from "react";
import { Example } from "@floot/examples";
import { Calendar } from "./Calendar";
import { Button } from "./Button";
import { Popover, PopoverTrigger, PopoverContent } from "./Popover";

const disabledDays = [
  new Date(2024, 0, 10),
  { from: new Date(2024, 0, 15), to: new Date(2024, 0, 18) },
];

function SingleDateCalendar() {
  const [date, setDate] = useState<Date>();
  return <Calendar mode="single" selected={date} onSelect={setDate} />;
}

function RangeCalendar() {
  const [dateRange, setDateRange] = useState<{
    from: Date | undefined;
    to?: Date;
  }>();
  return <Calendar mode="range" selected={dateRange} onSelect={setDateRange} />;
}

function DatePicker() {
  const [date, setDate] = useState<Date | undefined>(undefined);
  return (
    <Popover open modal={false}>
      <PopoverTrigger asChild>
        <Button variant="outline" style={{ minWidth: "8rem" }}>
          {date ? date.toLocaleDateString() : "Select Date"}
        </Button>
      </PopoverTrigger>
      <PopoverContent removeBackgroundAndPadding>
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d: Date | undefined) => {
            setDate(d);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export default function CalendarShowcase() {
  return (
    <>
      <h1>Calendar</h1>
      <p>
        A date grid built on react-day-picker. It selects a single day or a
        range, can block out dates, and can show more than one month at a time.
      </p>

      <h2>Modes</h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "flex-start",
        }}
      >
        <Example
          title="Single"
          description="One selected day at a time."
          width={340}
        >
          <SingleDateCalendar />
        </Example>

        <Example
          title="Range"
          description="A start and end day, with the days between them highlighted."
          width={340}
        >
          <RangeCalendar />
        </Example>

        <Example
          title="Disabled dates"
          description="Individual days and date ranges can be blocked out; a footer explains why."
          width={340}
        >
          <Calendar
            mode="single"
            disabled={disabledDays}
            defaultMonth={new Date(2024, 0)}
            footer="Some dates are disabled"
          />
        </Example>
      </div>

      <h2>Multiple months</h2>
      <Example
        title="Two months"
        description="Days outside each month are hidden."
        width={760}
      >
        <Calendar mode="single" numberOfMonths={2} showOutsideDays={false} />
      </Example>

      <h2>In a popover</h2>
      <Example
        title="Date picker"
        description="A button trigger that opens the calendar in a popover."
        width={340}
      >
        <div style={{ minHeight: 400 }}>
          <DatePicker />
        </div>
      </Example>
    </>
  );
}
