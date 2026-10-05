import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog
import pandas as pd
import numpy as np
import json
import re
import os


class CSVChannelEditor:
    def __init__(self, root):
        self.root = root
        self.root.title("DAQ CSV Channel Editor")
        self.root.geometry("1400x800")

        self.df = None
        self.csv_path = None

        # Tracks changes made to the original CSV
        self.rename_rules = {}
        self.calculated_channels = {}
        self.deleted_channels = []

        self.build_ui()

    # =========================================================
    # UI
    # =========================================================

    def build_ui(self):
        top = ttk.Frame(self.root)
        top.pack(fill="x", padx=10, pady=10)

        ttk.Button(
            top,
            text="Open CSV",
            command=self.open_csv
        ).pack(side="left", padx=4)

        ttk.Button(
            top,
            text="Save CSV As...",
            command=self.save_csv
        ).pack(side="left", padx=4)

        ttk.Separator(
            top,
            orient="vertical"
        ).pack(side="left", fill="y", padx=8)

        ttk.Button(
            top,
            text="Rename Channel",
            command=self.rename_channel
        ).pack(side="left", padx=4)

        ttk.Button(
            top,
            text="Add Calculated Channel",
            command=self.add_calculated_channel
        ).pack(side="left", padx=4)

        ttk.Button(
            top,
            text="Delete Channel",
            command=self.delete_channel
        ).pack(side="left", padx=4)

        ttk.Separator(
            top,
            orient="vertical"
        ).pack(side="left", fill="y", padx=8)

        ttk.Button(
            top,
            text="Save Preset",
            command=self.save_preset
        ).pack(side="left", padx=4)

        ttk.Button(
            top,
            text="Load / Apply Preset",
            command=self.load_preset
        ).pack(side="left", padx=4)

        # -----------------------------------------------------
        # Main split
        # -----------------------------------------------------

        main = ttk.PanedWindow(
            self.root,
            orient="horizontal"
        )
        main.pack(
            fill="both",
            expand=True,
            padx=10,
            pady=(0, 10)
        )

        # Left
        left = ttk.Frame(main)
        main.add(left, weight=1)

        ttk.Label(
            left,
            text="Channels"
        ).pack(anchor="w")

        list_frame = ttk.Frame(left)
        list_frame.pack(fill="both", expand=True)

        self.channel_list = tk.Listbox(
            list_frame,
            selectmode="browse",
            exportselection=False
        )

        self.channel_list.pack(
            side="left",
            fill="both",
            expand=True
        )

        scroll = ttk.Scrollbar(
            list_frame,
            orient="vertical",
            command=self.channel_list.yview
        )

        scroll.pack(
            side="right",
            fill="y"
        )

        self.channel_list.config(
            yscrollcommand=scroll.set
        )

        # Right
        right = ttk.Frame(main)
        main.add(right, weight=5)

        ttk.Label(
            right,
            text="Data Preview"
        ).pack(anchor="w")

        table_frame = ttk.Frame(right)
        table_frame.pack(
            fill="both",
            expand=True
        )

        self.tree = ttk.Treeview(
            table_frame,
            show="headings"
        )

        x_scroll = ttk.Scrollbar(
            table_frame,
            orient="horizontal",
            command=self.tree.xview
        )

        y_scroll = ttk.Scrollbar(
            table_frame,
            orient="vertical",
            command=self.tree.yview
        )

        self.tree.configure(
            xscrollcommand=x_scroll.set,
            yscrollcommand=y_scroll.set
        )

        self.tree.grid(
            row=0,
            column=0,
            sticky="nsew"
        )

        y_scroll.grid(
            row=0,
            column=1,
            sticky="ns"
        )

        x_scroll.grid(
            row=1,
            column=0,
            sticky="ew"
        )

        table_frame.rowconfigure(
            0,
            weight=1
        )

        table_frame.columnconfigure(
            0,
            weight=1
        )

        self.status = ttk.Label(
            self.root,
            text="No CSV loaded."
        )

        self.status.pack(
            fill="x",
            padx=10,
            pady=(0, 8)
        )

    # =========================================================
    # CSV
    # =========================================================

    def open_csv(self):
        path = filedialog.askopenfilename(
            title="Open DAQ CSV",
            filetypes=[
                ("CSV files", "*.csv"),
                ("All files", "*.*")
            ]
        )

        if not path:
            return

        try:
            self.df = pd.read_csv(path)
            self.csv_path = path

            # New CSV = clear current edit history
            self.rename_rules = {}
            self.calculated_channels = {}
            self.deleted_channels = []

            self.create_time_channel()

            self.refresh_all()

            self.status.config(
                text=(
                    f"Loaded {len(self.df):,} rows × "
                    f"{len(self.df.columns)} channels"
                )
            )

        except Exception as e:
            messagebox.showerror(
                "Error opening CSV",
                str(e)
            )

    def create_time_channel(self):
        if "Time (s)" in self.df.columns:
            return

        if "device_us" in self.df.columns:
            device_time = pd.to_numeric(
                self.df["device_us"],
                errors="coerce"
            )

            first_valid = device_time.dropna()

            if first_valid.empty:
                return

            t0 = first_valid.iloc[0]

            self.df.insert(
                0,
                "Time (s)",
                (device_time - t0) / 1_000_000.0
            )

        elif "received_utc" in self.df.columns:
            timestamps = pd.to_datetime(
                self.df["received_utc"],
                errors="coerce",
                utc=True
            )

            first_valid = timestamps.dropna()

            if first_valid.empty:
                return

            t0 = first_valid.iloc[0]

            self.df.insert(
                0,
                "Time (s)",
                (timestamps - t0).dt.total_seconds()
            )

    # =========================================================
    # DISPLAY
    # =========================================================

    def refresh_all(self):
        self.refresh_channels()
        self.refresh_table()

    def refresh_channels(self):
        self.channel_list.delete(
            0,
            tk.END
        )

        if self.df is None:
            return

        for col in self.df.columns:
            self.channel_list.insert(
                tk.END,
                col
            )

    def refresh_table(self, max_rows=200):
        self.tree.delete(
            *self.tree.get_children()
        )

        if self.df is None:
            return

        columns = list(
            self.df.columns
        )

        self.tree["columns"] = columns

        for col in columns:
            self.tree.heading(
                col,
                text=col
            )

            self.tree.column(
                col,
                width=max(
                    90,
                    min(
                        170,
                        len(col) * 9
                    )
                ),
                anchor="center"
            )

        preview = self.df.head(
            max_rows
        )

        for _, row in preview.iterrows():
            values = []

            for value in row:
                if pd.isna(value):
                    values.append("")

                elif isinstance(
                    value,
                    (float, np.floating)
                ):
                    values.append(
                        f"{value:.7g}"
                    )

                else:
                    values.append(
                        str(value)
                    )

            self.tree.insert(
                "",
                "end",
                values=values
            )

    # =========================================================
    # CHANNEL MANAGEMENT
    # =========================================================

    def get_selected_channel(self):
        selection = (
            self.channel_list.curselection()
        )

        if not selection:
            messagebox.showinfo(
                "Select channel",
                "Select a channel first."
            )
            return None

        return self.channel_list.get(
            selection[0]
        )

    def rename_channel(self):
        if self.df is None:
            return

        old_name = (
            self.get_selected_channel()
        )

        if old_name is None:
            return

        new_name = simpledialog.askstring(
            "Rename Channel",
            f"Rename:\n\n{old_name}\n\nto:"
        )

        if not new_name:
            return

        new_name = new_name.strip()

        if new_name in self.df.columns:
            messagebox.showerror(
                "Duplicate name",
                f"'{new_name}' already exists."
            )
            return

        # -------------------------------------------------
        # Track original raw channel -> final name
        # -------------------------------------------------

        original_name = old_name

        for raw_name, renamed in list(
            self.rename_rules.items()
        ):
            if renamed == old_name:
                original_name = raw_name
                break

        self.rename_rules[
            original_name
        ] = new_name

        # -------------------------------------------------
        # Update dataframe
        # -------------------------------------------------

        self.df.rename(
            columns={
                old_name: new_name
            },
            inplace=True
        )

        # -------------------------------------------------
        # Fix calculated expressions that reference it
        # -------------------------------------------------

        for calc_name in list(
            self.calculated_channels.keys()
        ):
            expression = (
                self.calculated_channels[
                    calc_name
                ]
            )

            expression = expression.replace(
                "{" + old_name + "}",
                "{" + new_name + "}"
            )

            self.calculated_channels[
                calc_name
            ] = expression

        self.refresh_all()

    def delete_channel(self):
        if self.df is None:
            return

        channel = (
            self.get_selected_channel()
        )

        if channel is None:
            return

        if not messagebox.askyesno(
            "Delete Channel",
            f"Delete '{channel}'?"
        ):
            return

        self.df.drop(
            columns=[channel],
            inplace=True
        )

        # If it's a calculated channel,
        # remove it from calculations
        if channel in self.calculated_channels:
            del self.calculated_channels[
                channel
            ]

        else:
            # Find original raw channel if renamed
            original = channel

            for raw_name, renamed in (
                self.rename_rules.items()
            ):
                if renamed == channel:
                    original = raw_name
                    break

            if original not in self.deleted_channels:
                self.deleted_channels.append(
                    original
                )

        self.refresh_all()

    # =========================================================
    # CALCULATED CHANNELS
    # =========================================================

    def add_calculated_channel(self):
        if self.df is None:
            return

        window = tk.Toplevel(self.root)
        window.title("Add Calculated Channel")
        window.geometry("700x420")
        window.transient(self.root)
        window.grab_set()

        # Main content frame
        content = ttk.Frame(window)
        content.pack(
            side="top",
            fill="both",
            expand=True,
            padx=10,
            pady=10
        )

        ttk.Label(
            content,
            text="New channel name:"
        ).pack(anchor="w")

        name_entry = ttk.Entry(content)
        name_entry.pack(
            fill="x",
            pady=(2, 10)
        )

        ttk.Label(
            content,
            text="Expression:"
        ).pack(anchor="w")

        expression_entry = ttk.Entry(content)
        expression_entry.pack(
            fill="x",
            pady=(2, 10)
        )

        info = """Reference channels using {curly braces}.

    Examples:

        {ch0_volts} * 4
        ({Pressure Voltage} - 0.5) * 250
        sqrt({accel_g_x}**2 + {accel_g_y}**2 + {accel_g_z}**2)

    Functions:
        sqrt()  abs()  sin()  cos()  tan()
        log()   log10()   exp()

    Operators:
        +  -  *  /  **  %
    """

        ttk.Label(
            content,
            text=info,
            justify="left"
        ).pack(
            anchor="w",
            pady=(5, 0)
        )

        def create():
            name = name_entry.get().strip()
            expression = expression_entry.get().strip()

            if not name:
                messagebox.showerror(
                    "Missing name",
                    "Enter a channel name.",
                    parent=window
                )
                return

            if not expression:
                messagebox.showerror(
                    "Missing expression",
                    "Enter an expression.",
                    parent=window
                )
                return

            if name in self.df.columns:
                messagebox.showerror(
                    "Duplicate channel",
                    f"'{name}' already exists.",
                    parent=window
                )
                return

            try:
                result = self.evaluate_expression(expression)

                self.df[name] = result
                self.calculated_channels[name] = expression

                window.destroy()
                self.refresh_all()

            except Exception as e:
                messagebox.showerror(
                    "Expression Error",
                    str(e),
                    parent=window
                )

        # IMPORTANT:
        # This must be OUTSIDE def create()
        button_frame = ttk.Frame(window)
        button_frame.pack(
            side="bottom",
            fill="x",
            padx=10,
            pady=10
        )

        ttk.Button(
            button_frame,
            text="Cancel",
            command=window.destroy
        ).pack(
            side="right",
            padx=(5, 0)
        )

        ttk.Button(
            button_frame,
            text="Create Channel",
            command=create
        ).pack(
            side="right"
        )

        # Pressing Enter submits
        window.bind(
            "<Return>",
            lambda event: create()
        )

        # Pressing Escape cancels
        window.bind(
            "<Escape>",
            lambda event: window.destroy()
        )

        name_entry.focus_set()
    
    def evaluate_expression(
        self,
        expression
    ):
        channel_refs = re.findall(
            r"\{([^}]+)\}",
            expression
        )

        local_vars = {}
        converted = expression

        for i, channel in enumerate(
            channel_refs
        ):
            if channel not in self.df.columns:
                raise ValueError(
                    f"Channel '{channel}' does not exist."
                )

            safe_name = (
                f"_channel_{i}"
            )

            converted = converted.replace(
                "{" + channel + "}",
                safe_name
            )

            local_vars[
                safe_name
            ] = pd.to_numeric(
                self.df[channel],
                errors="coerce"
            )

        local_vars.update({
            "sqrt": np.sqrt,
            "abs": np.abs,
            "sin": np.sin,
            "cos": np.cos,
            "tan": np.tan,
            "log": np.log,
            "log10": np.log10,
            "exp": np.exp,
            "pi": np.pi,
        })

        result = eval(
            converted,
            {
                "__builtins__": {}
            },
            local_vars
        )

        if np.isscalar(result):
            result = pd.Series(
                result,
                index=self.df.index
            )

        return result

    # =========================================================
    # PRESETS
    # =========================================================

    def save_preset(self):
        if self.df is None:
            messagebox.showinfo(
                "No CSV",
                "Open a CSV first."
            )
            return

        path = filedialog.asksaveasfilename(
            title="Save Processing Preset",
            defaultextension=".json",
            filetypes=[
                ("DAQ Preset", "*.json"),
                ("All files", "*.*")
            ]
        )

        if not path:
            return

        preset = {
            "version": 1,

            "renames": (
                self.rename_rules
            ),

            "calculated_channels": (
                self.calculated_channels
            ),

            "deleted_channels": (
                self.deleted_channels
            )
        }

        try:
            with open(
                path,
                "w",
                encoding="utf-8"
            ) as f:
                json.dump(
                    preset,
                    f,
                    indent=4
                )

            messagebox.showinfo(
                "Preset Saved",
                f"Preset saved:\n\n{path}"
            )

        except Exception as e:
            messagebox.showerror(
                "Preset Error",
                str(e)
            )

    def load_preset(self):
        if self.df is None:
            messagebox.showinfo(
                "Open CSV",
                "Open a CSV before applying a preset."
            )
            return

        path = filedialog.askopenfilename(
            title="Load Processing Preset",
            filetypes=[
                ("DAQ Preset", "*.json"),
                ("All files", "*.*")
            ]
        )

        if not path:
            return

        try:
            with open(
                path,
                "r",
                encoding="utf-8"
            ) as f:
                preset = json.load(f)

            self.apply_preset(
                preset
            )

            self.status.config(
                text=(
                    f"Applied preset: "
                    f"{os.path.basename(path)}"
                )
            )

        except Exception as e:
            messagebox.showerror(
                "Preset Error",
                str(e)
            )

    def apply_preset(
        self,
        preset
    ):
        errors = []

        # -------------------------------------------------
        # Renames first
        # -------------------------------------------------

        renames = preset.get(
            "renames",
            {}
        )

        for old_name, new_name in (
            renames.items()
        ):

            if old_name in self.df.columns:

                if new_name in self.df.columns:
                    errors.append(
                        f"Cannot rename "
                        f"{old_name} -> {new_name}: "
                        f"destination already exists."
                    )

                else:
                    self.df.rename(
                        columns={
                            old_name: new_name
                        },
                        inplace=True
                    )

            elif new_name not in self.df.columns:
                errors.append(
                    f"Missing channel: {old_name}"
                )

        # -------------------------------------------------
        # Delete channels
        # -------------------------------------------------

        deleted = preset.get(
            "deleted_channels",
            []
        )

        for raw_name in deleted:

            current_name = renames.get(
                raw_name,
                raw_name
            )

            if current_name in self.df.columns:
                self.df.drop(
                    columns=[current_name],
                    inplace=True
                )

        # -------------------------------------------------
        # Calculated channels
        # -------------------------------------------------

        calculations = preset.get(
            "calculated_channels",
            {}
        )

        for name, expression in (
            calculations.items()
        ):

            try:
                self.df[name] = (
                    self.evaluate_expression(
                        expression
                    )
                )

            except Exception as e:
                errors.append(
                    f"{name}: {e}"
                )

        # Save rules locally so the preset
        # can later be modified and re-saved.
        self.rename_rules = dict(
            renames
        )

        self.calculated_channels = dict(
            calculations
        )

        self.deleted_channels = list(
            deleted
        )

        self.refresh_all()

        if errors:
            messagebox.showwarning(
                "Preset Applied With Warnings",
                "\n\n".join(errors)
            )

        else:
            messagebox.showinfo(
                "Preset Applied",
                "Preset applied successfully."
            )

    # =========================================================
    # SAVE
    # =========================================================

    def save_csv(self):
        if self.df is None:
            messagebox.showinfo(
                "Nothing to save",
                "Open a CSV first."
            )
            return

        path = filedialog.asksaveasfilename(
            title="Save Processed CSV",
            defaultextension=".csv",
            filetypes=[
                ("CSV files", "*.csv"),
                ("All files", "*.*")
            ]
        )

        if not path:
            return

        try:
            self.df.to_csv(
                path,
                index=False
            )

            self.status.config(
                text=f"Saved: {path}"
            )

        except Exception as e:
            messagebox.showerror(
                "Save Error",
                str(e)
            )


if __name__ == "__main__":
    root = tk.Tk()
    app = CSVChannelEditor(root)
    root.mainloop()