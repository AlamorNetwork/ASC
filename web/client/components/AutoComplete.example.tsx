import { useState } from "react";
import { Mail, Package, User } from "lucide-react";
import { Example } from "@floot/examples";
import { AutoComplete, type Option } from "./AutoComplete";

const colors: Option[] = [
  { value: "red", label: "Red" },
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
  { value: "yellow", label: "Yellow" },
];

type Product = {
  id: string;
  name: string;
  category: string;
  price: number;
};

const products: Product[] = [
  {
    id: "1",
    name: "Mechanical Keyboard",
    category: "Electronics",
    price: 149.99,
  },
  { id: "2", name: "Ergonomic Mouse", category: "Electronics", price: 79.99 },
  { id: "3", name: '27" Monitor', category: "Electronics", price: 299.99 },
  { id: "4", name: "Laptop Stand", category: "Accessories", price: 49.99 },
];

type Person = {
  id: string;
  name: string;
  email: string;
  role: string;
};

const users: Person[] = [
  {
    id: "1",
    name: "Sarah Wilson",
    email: "sarah@example.com",
    role: "Designer",
  },
  { id: "2", name: "Mike Chen", email: "mike@example.com", role: "Developer" },
  { id: "3", name: "Emma Davis", email: "emma@example.com", role: "Manager" },
  { id: "4", name: "James Lee", email: "james@example.com", role: "Developer" },
];

function StrictColorAutoComplete() {
  const [selected, setSelected] = useState<Option>();
  const [inputValue, setInputValue] = useState("");

  return (
    <div style={{ minHeight: 240 }}>
      <AutoComplete
        options={colors}
        value={selected}
        onValueChange={setSelected}
        inputValue={inputValue}
        onInputValueChange={setInputValue}
        placeholder="Select a color..."
        emptyMessage="No colors found"
        allowFreeForm={false}
      />
      <div style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
        Input value: "{inputValue}"
      </div>
    </div>
  );
}

function FreeFormColorAutoComplete() {
  const [selected, setSelected] = useState<Option>();
  const [inputValue, setInputValue] = useState("");

  return (
    <div style={{ minHeight: 240 }}>
      <AutoComplete
        options={colors}
        value={selected}
        onValueChange={setSelected}
        inputValue={inputValue}
        onInputValueChange={setInputValue}
        placeholder="Type any color..."
        emptyMessage="No colors found"
        allowFreeForm={true}
      />
      <div style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
        Input value: "{inputValue}"
      </div>
    </div>
  );
}

function UserAutoComplete() {
  const [selected, setSelected] = useState<Option<Person>>();
  const [inputValue, setInputValue] = useState("");

  const userOptions: Option<Person>[] = users.map((user) => ({
    value: user.id,
    label: (
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <User size={16} />
        <div>
          <div style={{ fontWeight: 500 }}>{user.name}</div>
          <div
            style={{
              fontSize: "0.75rem",
              color: "var(--muted-foreground)",
              display: "flex",
              alignItems: "center",
              gap: "0.25rem",
            }}
          >
            <Mail size={12} />
            {user.email} • {user.role}
          </div>
        </div>
      </div>
    ),
    displayText: user.name,
    metadata: user,
  }));

  return (
    <div style={{ minHeight: 300 }}>
      <AutoComplete
        options={userOptions}
        value={selected}
        onValueChange={setSelected}
        inputValue={inputValue}
        onInputValueChange={setInputValue}
        placeholder="Search users or enter a name..."
        emptyMessage="No users found"
        allowFreeForm={true}
      />
      <div style={{ marginTop: "1rem", fontSize: "0.875rem" }}>
        <div>Current input: {inputValue}</div>
        {selected?.metadata && (
          <div style={{ marginTop: "0.5rem" }}>
            Selected user: {selected.metadata.name} ({selected.metadata.role})
          </div>
        )}
      </div>
    </div>
  );
}

function ProductAutoComplete() {
  const [selected, setSelected] = useState<Option<Product>>();
  const [inputValue, setInputValue] = useState("");

  const productOptions: Option<Product>[] = products.map((product) => ({
    value: product.id,
    label: (
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <Package size={16} />
        <div>
          <div style={{ fontWeight: 500 }}>{product.name}</div>
          <div style={{ fontSize: "0.75rem", color: "var(--muted-foreground)" }}>
            {product.category} • ${product.price}
          </div>
        </div>
      </div>
    ),
    displayText: product.name,
    metadata: product,
  }));

  return (
    <div style={{ minHeight: 300 }}>
      <AutoComplete
        options={productOptions}
        value={selected}
        onValueChange={setSelected}
        inputValue={inputValue}
        onInputValueChange={setInputValue}
        placeholder="Search products or enter item..."
        emptyMessage="No products found"
        allowFreeForm={true}
      />
      <div style={{ marginTop: "1rem", fontSize: "0.875rem" }}>
        <div>Current input: {inputValue}</div>
        {selected?.metadata && (
          <div style={{ marginTop: "0.5rem" }}>
            Selected product: {selected.metadata.name} ($
            {selected.metadata.price})
          </div>
        )}
      </div>
    </div>
  );
}

export default function AutoCompleteShowcase() {
  return (
    <>
      <h1>AutoComplete</h1>
      <p>
        A text input that suggests matching options as you type. Options can be
        plain text or rich rows, and typing can be restricted to the listed
        options or left free-form.
      </p>

      <h2>Input modes</h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "flex-start",
        }}
      >
        <Example
          title="Strict selection"
          description="allowFreeForm={false} — only listed options are accepted."
          width={320}
        >
          <StrictColorAutoComplete />
        </Example>

        <Example
          title="Free-form"
          description="allowFreeForm={true} — any typed text is kept."
          width={320}
        >
          <FreeFormColorAutoComplete />
        </Example>
      </div>

      <h2>Rich options</h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          alignItems: "flex-start",
        }}
      >
        <Example title="User search" width={400}>
          <UserAutoComplete />
        </Example>

        <Example title="Product search" width={400}>
          <ProductAutoComplete />
        </Example>
      </div>
    </>
  );
}
