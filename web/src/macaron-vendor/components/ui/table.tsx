import React from "react";
import { cn } from "@/lib/style";

/** Dense aligned data. Use cards/lists for decorative or narrative collections. */
const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(({ className, ...props }, ref) => (
  <div data-slot="table-container" className="relative w-full overflow-x-auto">
    <table ref={ref} data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
  </div>
));
Table.displayName = "Table";

/** Header section for column labels. */
const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => <thead ref={ref} data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />);
TableHeader.displayName = "TableHeader";

/** Body section for data rows. */
const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => <tbody ref={ref} data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />);
TableBody.displayName = "TableBody";

/** Footer section for totals or summary rows. */
const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => <tfoot ref={ref} data-slot="table-footer" className={cn("border-t bg-black/[0.03] font-medium [&>tr]:last:border-b-0", className)} {...props} />);
TableFooter.displayName = "TableFooter";

/** Row grouping table cells. */
const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(({ className, ...props }, ref) => <tr ref={ref} data-slot="table-row" className={cn("border-b border-black/[0.08] transition-colors hover:bg-black/[0.025] data-[state=selected]:bg-black/[0.04]", className)} {...props} />);
TableRow.displayName = "TableRow";

/** Column label cell. */
const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(({ className, ...props }, ref) => <th ref={ref} data-slot="table-head" className={cn("h-10 px-3 text-left align-middle font-medium text-[#171411] [&:has([role=checkbox])]:pr-0", className)} {...props} />);
TableHead.displayName = "TableHead";

/** Data or summary cell. */
const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(({ className, ...props }, ref) => <td ref={ref} data-slot="table-cell" className={cn("p-3 align-middle text-[#2D2925] [&:has([role=checkbox])]:pr-0", className)} {...props} />);
TableCell.displayName = "TableCell";

/** Concise accessible caption. */
const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(({ className, ...props }, ref) => <caption ref={ref} data-slot="table-caption" className={cn("mt-4 text-sm text-[#6F655B]", className)} {...props} />);
TableCaption.displayName = "TableCaption";

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
