/**
 * Holiday Theme Manager
 * Manages automatic theme switching based on Vietnamese holidays
 */

interface HolidayConfig {
  holidays: Holiday[];
}

interface Holiday {
  id: string;
  name: string;
  type: "solar" | "lunar";
  date: string; // Format: "M/D"
  daysBefore: number;
  daysAfter: number;
  enabled?: boolean;
  theme: HolidayTheme;
}

interface HolidayTheme {
  backgroundImage: string;
  animations: string[];
}

interface LunarDate {
  day: number;
  month: number;
  year: number;
}

class HolidayThemeManager {
  private config: HolidayConfig | null = null;
  private currentHoliday: Holiday | null = null;
  private animationContainer: HTMLElement | null = null;

  /**
   * Initialize the holiday theme manager
   */
  public async init(): Promise<void> {
    this.loadConfig()
      .then(() => {
        this.listeners();
        this.createAnimationContainer();
        this.checkAndApplyHolidayTheme();

        // Check daily for holiday changes
        setInterval(() => {
          this.checkAndApplyHolidayTheme();
        }, 24 * 60 * 60 * 1000); // Check every 24 hours
      })
      .catch((error) => {
        console.error("Failed to initialize Holiday Theme Manager:", error);
      });
  }

  /**
   * Load holidays configuration
   */
  private async loadConfig(): Promise<void> {
    try {
      this.config = await window.api.loadHolidaysConfig();
    } catch (error) {
      console.error("Failed to load holidays config:", error);
      throw error;
    }
  }

  private listeners(): void {
    const backgroundToggle = document.getElementById("backgroundToggle") as HTMLInputElement;
    const savedEnableBackground = localStorage.getItem("enableBackground") || true.toString();
    if (savedEnableBackground === "true") {
      backgroundToggle.checked = true;
    } else {
      backgroundToggle.checked = false;
    }

    backgroundToggle.addEventListener("change", () => {
      this.toggleBackground(backgroundToggle.checked);
    });
  }

  private toggleBackground(enable: boolean): void {
    const backgroundToggle = document.getElementById("backgroundToggle") as HTMLInputElement;
    if (enable) {
      backgroundToggle.checked = true;
      localStorage.setItem("enableBackground", true.toString());
      this.checkAndApplyHolidayTheme();
    } else {
      backgroundToggle.checked = false;
      localStorage.setItem("enableBackground", false.toString());
      if (this.currentHoliday) {
        this.removeHolidayTheme();
        this.currentHoliday = null;
      }
    }
  }

  /**
   * Create container for animations
   */
  private createAnimationContainer(): void {
    this.animationContainer = document.createElement("div");
    this.animationContainer.id = "holiday-animations";
    this.animationContainer.className = "holiday-animations";
    document.body.appendChild(this.animationContainer);
  }

  /**
   * Check if current date is within any holiday period and apply theme
   */
  private checkAndApplyHolidayTheme(): void {
    if (!this.config) return;

    const backgroundToggle = document.getElementById("backgroundToggle") as HTMLInputElement;
    if (!backgroundToggle.checked) {
      return;
    }

    const today = new Date();
    const activeHoliday = this.findActiveHoliday(today);

    if (activeHoliday) {
      if (this.currentHoliday?.id !== activeHoliday.id) {
        this.applyHolidayTheme(activeHoliday);
        this.currentHoliday = activeHoliday;
      }
    } else {
      if (this.currentHoliday) {
        this.removeHolidayTheme();
        this.currentHoliday = null;
      }
    }
  }

  /**
   * Find active holiday for given date
   */
  private findActiveHoliday(date: Date): Holiday | null {
    if (!this.config) return null;

    const holidays = this.config.holidays.filter((h) => !!h.enabled);
    for (const holiday of holidays) {
      if (this.isDateInHolidayPeriod(date, holiday)) {
        return holiday;
      }
    }

    return null;
  }

  /**
   * Check if date is within holiday period
   * Fixed: Now checks both current year and next year for holidays
   */
  private isDateInHolidayPeriod(date: Date, holiday: Holiday): boolean {
    const [month, day] = holiday.date.split("/").map(Number);

    // Check both current year and next year
    // This handles cases where we're at year-end checking next year's holiday
    const yearsToCheck = [date.getFullYear(), date.getFullYear() + 1];

    for (const year of yearsToCheck) {
      let holidayDate: Date;

      if (holiday.type === "solar") {
        holidayDate = new Date(year, month - 1, day);
      } else {
        // Convert lunar date to solar date
        const solarDate = this.lunarToSolar(day, month, year);
        if (!solarDate) continue;
        holidayDate = new Date(solarDate.year, solarDate.month - 1, solarDate.day);
      }

      // Calculate date range
      const startDate = new Date(holidayDate);
      startDate.setDate(startDate.getDate() - holiday.daysBefore);

      const endDate = new Date(holidayDate);
      endDate.setDate(endDate.getDate() + holiday.daysAfter);

      // Reset time to compare dates only
      const checkDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const checkStart = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
      const checkEnd = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());

      if (checkDate >= checkStart && checkDate <= checkEnd) {
        console.log(`✅ Holiday "${holiday.name}" is active!`);
        console.log(`   Current: ${checkDate.toLocaleDateString("vi-VN")}`);
        console.log(`   Holiday: ${holidayDate.toLocaleDateString("vi-VN")}`);
        console.log(`   Period: ${checkStart.toLocaleDateString("vi-VN")} → ${checkEnd.toLocaleDateString("vi-VN")}`);
        return true;
      }
    }

    return false;
  }

  /**
   * Apply holiday theme
   */
  private applyHolidayTheme(holiday: Holiday): void {
    const mainContent = document.querySelector(".main-content") as HTMLElement;
    if (!mainContent) return;

    // Apply background image
    mainContent.style.backgroundImage = `url('${holiday.theme.backgroundImage}')`;
    mainContent.style.backgroundSize = "cover";
    mainContent.style.backgroundPosition = "center";
    mainContent.style.backgroundRepeat = "no-repeat";

    // Add holiday class for additional styling
    mainContent.classList.add("holiday-theme", `holiday-${holiday.id}`);

    // Apply animations
    this.applyAnimations(holiday.theme.animations);

    console.log(`🎉 Applied holiday theme: ${holiday.name}`);
  }

  /**
   * Remove holiday theme
   */
  private removeHolidayTheme(): void {
    const mainContent = document.querySelector(".main-content") as HTMLElement;
    if (!mainContent) return;

    mainContent.style.backgroundImage = "";
    mainContent.classList.remove("holiday-theme");

    // Remove all holiday-specific classes
    mainContent.className = mainContent.className
      .split(" ")
      .filter((c) => !c.startsWith("holiday-"))
      .join(" ");

    // Clear animations
    if (this.animationContainer) {
      this.animationContainer.innerHTML = "";
    }

    console.log("❌ Removed holiday theme");
  }

  /**
   * Apply animations based on holiday type
   */
  private applyAnimations(animations: string[]): void {
    if (!this.animationContainer) return;

    this.animationContainer.innerHTML = "";

    animations.forEach((animation) => {
      switch (animation) {
        case "snow":
          this.createSnowfall();
          break;
        case "peach-blossom":
        case "flowers":
          this.createFallingFlowers();
          break;
        case "fireworks":
          this.createFireworks();
          break;
        case "lanterns":
          this.createLanterns();
          break;
        case "flags":
          this.createFlags();
          break;
        case "moon":
          this.createMoon();
          break;
        case "stars":
          this.createStars();
          break;
        case "christmas-tree":
          this.createChristmasTree();
          break;
      }
    });
  }

  /**
   * Create snowfall animation
   */
  private createSnowfall(): void {
    const count = 20;
    for (let i = 0; i < count; i++) {
      const snowflake = document.createElement("div");
      snowflake.className = "snowflake";
      snowflake.textContent = "❄";
      snowflake.style.left = Math.random() * 100 + "%";
      snowflake.style.animationDuration = Math.random() * 3 + 2 + "s";
      snowflake.style.animationDelay = Math.random() * 5 + "s";
      snowflake.style.fontSize = Math.random() * 10 + 10 + "px";
      this.animationContainer?.appendChild(snowflake);
    }
  }

  /**
   * Create falling flowers animation
   */
  private createFallingFlowers(): void {
    const count = 15;
    const flowers = ["🌸", "🌺", "🌼", "🌻"];

    for (let i = 0; i < count; i++) {
      const flower = document.createElement("div");
      flower.className = "falling-flower";
      flower.textContent = flowers[Math.floor(Math.random() * flowers.length)];
      flower.style.left = Math.random() * 100 + "%";
      flower.style.animationDuration = Math.random() * 4 + 3 + "s";
      flower.style.animationDelay = Math.random() * 5 + "s";
      flower.style.fontSize = Math.random() * 15 + 15 + "px";
      this.animationContainer?.appendChild(flower);
    }
  }

  /**
   * Create fireworks animation
   */
  private createFireworks(): void {
    const count = 3;
    for (let i = 0; i < count; i++) {
      const firework = document.createElement("div");
      firework.className = "firework";
      firework.textContent = "✨";
      firework.style.left = 20 + Math.random() * 60 + "%";
      firework.style.top = 10 + Math.random() * 30 + "%";
      firework.style.animationDelay = Math.random() * 3 + "s";
      this.animationContainer?.appendChild(firework);
    }
  }

  /**
   * Create lanterns animation
   */
  private createLanterns(): void {
    const count = 5;
    for (let i = 0; i < count; i++) {
      const lantern = document.createElement("div");
      lantern.className = "lantern";
      lantern.textContent = "🏮";
      lantern.style.left = i * 20 + 10 + "%";
      lantern.style.animationDelay = i * 0.5 + "s";
      this.animationContainer?.appendChild(lantern);
    }
  }

  /**
   * Create flags animation
   */
  private createFlags(): void {
    const count = 7;
    for (let i = 0; i < count; i++) {
      const flag = document.createElement("div");
      flag.className = "flag";
      flag.textContent = "🇻🇳";
      flag.style.right = i * 12.5 + "%";
      flag.style.animationDelay = i * 0.2 + "s";
      this.animationContainer?.appendChild(flag);
    }
  }

  /**
   * Create moon
   */
  private createMoon(): void {
    const moon = document.createElement("div");
    moon.className = "moon";
    moon.textContent = "🌕";
    this.animationContainer?.appendChild(moon);
  }

  /**
   * Create stars
   */
  private createStars(): void {
    const count = 10;
    for (let i = 0; i < count; i++) {
      const star = document.createElement("div");
      star.className = "star";
      star.textContent = "⭐";
      star.style.left = 10 + Math.random() * 90 + "%";
      star.style.top = 10 + Math.random() * 90 + "%";
      star.style.animationDelay = Math.random() * 2 + "s";
      star.style.fontSize = Math.random() * 10 + 10 + "px";
      this.animationContainer?.appendChild(star);
    }
  }

  /**
   * Create Christmas tree
   */
  private createChristmasTree(): void {
    const tree = document.createElement("div");
    tree.className = "christmas-tree";
    tree.textContent = "🎄";
    this.animationContainer?.appendChild(tree);
  }

  /**
   * Convert lunar date to solar date (simplified algorithm)
   * This is a basic implementation. For production, consider using a library like `lunar-javascript`
   */
  private lunarToSolar(lunarDay: number, lunarMonth: number, solarYear: number): LunarDate | null {
    // This is a simplified conversion table for common Vietnamese holidays
    // TODO: 3/10 for 2028-2030 (4/5, 4/24, 4/13) looks off by 1-2 days; verify or use a lunar calendar library
    // For accurate conversion, you should use a proper lunar calendar library

    const conversionTable: { [key: string]: { [year: number]: string } } = {
      "1/1": {
        // Tết
        2024: "2/10",
        2025: "1/29",
        2026: "2/17",
        2027: "2/6",
        2028: "1/26",
        2029: "2/13",
        2030: "2/3",
      },
      "3/10": {
        // Giỗ Tổ Hùng Vương
        2024: "4/18",
        2025: "4/7",
        2026: "4/26",
        2027: "4/16",
        2028: "4/5",
        2029: "4/24",
        2030: "4/13",
      },
      "8/15": {
        // Trung Thu
        2024: "9/17",
        2025: "10/6",
        2026: "9/25",
        2027: "9/15",
        2028: "10/3",
        2029: "9/22",
        2030: "9/12",
      },
    };

    const key = `${lunarMonth}/${lunarDay}`;
    const yearData = conversionTable[key];

    if (yearData && yearData[solarYear]) {
      const [month, day] = yearData[solarYear].split("/").map(Number);
      return { day, month, year: solarYear };
    }

    return null;
  }
}

// Initialize on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    const holidayThemeManager = new HolidayThemeManager();
    holidayThemeManager.init();
  });
}

// No export needed for side-effect only import
