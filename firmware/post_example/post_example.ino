/*
  SmartPosture AI - ESP32 Firmware Snippet
  Hardware: ESP32 DevKit + 1x MPU6050 (back tilt) + I2C OLED (0x3C) +
            Vibration Motor + Buzzer + 1 RGB LED + 1 Button + Li-ion Battery (GPIO 34)

  Pins Contract:
  - I2C SDA: 21, SCL: 22 (MPU6050 0x68, OLED 0x3C)
  - Motor: 26
  - Buzzer: 25
  - RGB: R=19, G=18, B=23
  - Button: 27 (INPUT_PULLUP, press = calibrate baseline)
  - Battery Divider: 34 (ADC)
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <time.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// OLED Display Configuration (128x64 I2C SSD1306)
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
#define OLED_ADDR     0x3C
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
bool oledFound = false;

// Include credentials and configuration
#if __has_include("config.h")
  #include "config.h"
#else
  #include "config.h.example"
#endif

// Hardware Pin Definitions
#define PIN_SDA           21
#define PIN_SCL           22
#define PIN_MOTOR         26
#define PIN_BUZZER        25
#define PIN_LED_RED       19  // Red LED (+): Bad Posture Indicator
#define PIN_LED_GREEN     18  // Green LED (+): Good Posture Indicator
#define PIN_LED_YELLOW    23  // Yellow LED (+): Device State Indicator (ON / Active)
#define PIN_BUTTON        27
#define PIN_BATTERY_ADC   34

// MPU6050 I2C Address
#define MPU_ADDR 0x68

// State Variables
float baselineAngle = 8.0;
float currentAngle = 8.0;
float movementLevel = 0.2;
String currentState = "good";

unsigned long poorPostureStartMs = 0; // Tracks duration in warning or bad posture
bool vibrationActive = false;
bool buzzerActive = false;
unsigned long alertStartMs = 0;

// NTP Time Configuration
const char* ntpServer = "pool.ntp.org";
const long gmtOffset_sec = 0;
const int daylightOffset_sec = 0;

// Telemetry Buffers (posts every 10s)
#define MAX_BUFFER_SIZE 20
struct ReadingItem {
  char ts[25];
  float angle;
  char state[10];
  float movement;
};

struct AlertItem {
  char ts[25];
  char level[12];
  int duration_s;
  char reason[16];
  int recovery_time_s;
};

struct EventItem {
  char ts[25];
  char type[16];
  float angle;
};

ReadingItem readingsBuffer[MAX_BUFFER_SIZE];
int readingsCount = 0;

AlertItem alertsBuffer[5];
int alertsCount = 0;

EventItem eventsBuffer[5];
int eventsCount = 0;

unsigned long lastPostMs = 0;
const unsigned long POST_INTERVAL_MS = 1000; // Stream telemetry every 1 second to cloud

// Exponential Backoff
int backoffDelayMs = 1000;
const int MAX_BACKOFF_MS = 30000;

// Update 3 Status LEDs
// Red (GPIO 19): Bad Posture Indicator
// Green (GPIO 18): Good Posture Indicator
// Yellow (GPIO 23): Device State Indicator (Solid ON = Device Powered & Active)
void updateLEDs(String state) {
  // Yellow LED indicates device state (ON / Active)
  digitalWrite(PIN_LED_YELLOW, HIGH);

  if (state == "good") {
    digitalWrite(PIN_LED_GREEN, HIGH);
    digitalWrite(PIN_LED_RED, LOW);
  } else if (state == "warning") {
    // In warning posture: Green is OFF, Red blinks as an early caution
    static unsigned long lastBlinkMs = 0;
    static bool blinkState = false;
    if (millis() - lastBlinkMs >= 350) {
      lastBlinkMs = millis();
      blinkState = !blinkState;
    }
    digitalWrite(PIN_LED_GREEN, LOW);
    digitalWrite(PIN_LED_RED, blinkState ? HIGH : LOW);
  } else { // bad posture
    digitalWrite(PIN_LED_GREEN, LOW);
    digitalWrite(PIN_LED_RED, HIGH); // Solid Red: Bad Posture
  }
}

// Get ISO 8601 Timestamp String
void getIsoTimestamp(char* buffer, size_t maxLen) {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) {
    snprintf(buffer, maxLen, "2026-10-22T12:00:00Z");
    return;
  }
  strftime(buffer, maxLen, "%Y-%m-%dT%H:%M:%SZ", &timeinfo);
}

// Read Battery Percentage from GPIO 34 (100k/100k divider)
// Returns -1 if no battery divider is connected (running on USB power)
int readBatteryPct() {
  int raw = analogRead(PIN_BATTERY_ADC);
  if (raw < 500) return -1; // Floating pin / USB powered without battery divider
  // ADC 12-bit: 0 - 4095. Voltage: raw * (3.3 / 4095) * 2
  float voltage = (raw / 4095.0) * 3.3 * 2.0;
  if (voltage < 3.0) return 0;
  if (voltage > 4.2) return 100;
  return (int)((voltage - 3.0) / (4.2 - 3.0) * 100.0);
}

// Initialize MPU6050 with I2C bus scan diagnostics
void initMPU6050() {
  Wire.begin(PIN_SDA, PIN_SCL);
  delay(100);

  Serial.println("[I2C] Scanning I2C bus...");
  int nDevices = 0;
  for (byte address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    byte error = Wire.endTransmission();
    if (error == 0) {
      Serial.print("[I2C] Device found at address 0x");
      if (address < 16) Serial.print("0");
      Serial.print(address, HEX);
      if (address == 0x68) Serial.print(" (MPU6050 detected!)");
      if (address == 0x69) Serial.print(" (MPU6050 with AD0=HIGH!)");
      if (address == 0x3C || address == 0x3D) Serial.print(" (OLED display detected!)");
      Serial.println();
      nDevices++;
    }
  }

  if (nDevices == 0) {
    Serial.println("[I2C] ERROR: No I2C devices found! Check SDA (GPIO 21) & SCL (GPIO 22) connections.");
  } else {
    Serial.print("[I2C] Scan complete. Found ");
    Serial.print(nDevices);
    Serial.println(" device(s).");
  }

  // Wake up MPU6050
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B); // PWR_MGMT_1
  Wire.write(0);    // Wake up
  byte wakeErr = Wire.endTransmission(true);
  if (wakeErr == 0) {
    Serial.println("[IMU] MPU6050 wake-up SUCCESS");
  } else {
    Serial.print("[IMU] MPU6050 wake-up FAILED! Error code: ");
    Serial.println(wakeErr);
  }
}

// Read Back Tilt Angle and Movement
void readMPU6050(float &tiltDeg, float &movement) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B); // Starting at ACCEL_XOUT_H
  Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)MPU_ADDR, (size_t)6, true);

  if (Wire.available() >= 6) {
    int16_t AcX = Wire.read() << 8 | Wire.read();
    int16_t AcY = Wire.read() << 8 | Wire.read();
    int16_t AcZ = Wire.read() << 8 | Wire.read();

    // Convert raw to Gs
    float ax = AcX / 16384.0;
    float ay = AcY / 16384.0;
    float az = AcZ / 16384.0;

    // Pitch angle: back tilt in degrees
    tiltDeg = atan2(-ay, sqrt(ax * ax + az * az)) * 180.0 / PI;

    // Relative movement magnitude (deviation from 1G)
    float totalAcc = sqrt(ax * ax + ay * ay + az * az);
    movement = constrain(abs(totalAcc - 1.0) * 2.0, 0.0, 1.0);
  } else {
    static unsigned long lastWarn = 0;
    if (millis() - lastWarn > 5000) {
      lastWarn = millis();
      Serial.println("[IMU] WARNING: No data available from MPU6050!");
    }
  }
}

// Initialize OLED Display (SSD1306 128x64 I2C at 0x3C)
void initOLED() {
  if (display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    oledFound = true;
    Serial.println("[OLED] SSD1306 display initialized at 0x3C");
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(18, 18);
    display.print("SmartPosture AI");
    display.setCursor(24, 36);
    display.print("Connecting...");
    display.display();
  } else {
    oledFound = false;
    Serial.println("[OLED] NOTE: SSD1306 display not detected at 0x3C (optional)");
  }
}

// Show temporary calibration banner on OLED
void showCalibrationOLED(float angle) {
  if (!oledFound) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(16, 12);
  display.print("CALIBRATION SET");
  display.setTextSize(2);
  display.setCursor(28, 28);
  display.print(angle, 1);
  display.print((char)247);
  display.setTextSize(1);
  display.setCursor(14, 50);
  display.print("Upright Baseline");
  display.display();
}

// Render real-time angle and posture state on OLED
void updateOLED() {
  if (!oledFound) return;

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  // 1. Top Header Bar
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print("SmartPosture");

  display.setCursor(80, 0);
  if (WiFi.status() == WL_CONNECTED) {
    display.print("WiFi OK");
  } else {
    display.print("No WiFi");
  }
  display.drawLine(0, 9, 127, 9, SSD1306_WHITE);

  // 2. Large Current Angle (Size 2 font)
  display.setTextSize(2);
  display.setCursor(6, 16);
  display.print(currentAngle, 1);
  display.print((char)247); // Degree symbol

  // 3. Posture State Badge on the right
  display.setTextSize(1);
  display.setCursor(80, 18);
  if (currentState == "good") {
    display.print("[ GOOD ]");
  } else if (currentState == "warning") {
    display.print("[ WARN ]");
  } else {
    display.print("[ BAD! ]");
  }

  // 4. Baseline & Difference Info Line
  display.drawLine(0, 36, 127, 36, SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 41);
  float diff = abs(currentAngle - baselineAngle);
  display.print("Diff:");
  display.print(diff, 1);
  display.print((char)247);
  display.print(" Base:");
  display.print(baselineAngle, 1);
  display.print((char)247);

  // 5. Bottom Status / Alert Countdown Bar
  display.setCursor(0, 53);
  if (buzzerActive) {
    display.print("! BUZZER ALERT !");
  } else if (vibrationActive) {
    display.print("! VIBRATING...");
  } else if (currentState != "good" && poorPostureStartMs > 0) {
    unsigned long s = (millis() - poorPostureStartMs) / 1000;
    display.print("Slouching: ");
    display.print(s);
    display.print("s / 10s");
  } else {
    display.print("Posture: Normal");
  }

  display.display();
}

// Calibrate Baseline to current upright angle
void calibrateBaseline() {
  float sum = 0;
  float mov = 0;
  for (int i = 0; i < 10; i++) {
    float a, m;
    readMPU6050(a, m);
    sum += a;
    delay(20);
  }
  baselineAngle = sum / 10.0;
  showCalibrationOLED(baselineAngle);

  char ts[25];
  getIsoTimestamp(ts, sizeof(ts));
  if (eventsCount < 5) {
    strncpy(eventsBuffer[eventsCount].ts, ts, sizeof(eventsBuffer[eventsCount].ts));
    strncpy(eventsBuffer[eventsCount].type, "calibration", sizeof(eventsBuffer[eventsCount].type));
    eventsBuffer[eventsCount].angle = baselineAngle;
    eventsCount++;
  }

  // Quick double buzz to confirm calibration
  digitalWrite(PIN_BUZZER, HIGH);
  delay(80);
  digitalWrite(PIN_BUZZER, LOW);
  delay(60);
  digitalWrite(PIN_BUZZER, HIGH);
  delay(80);
  digitalWrite(PIN_BUZZER, LOW);
}

// Transmit telemetry to Cloud Ingest Function (streamed every 1s)
void postTelemetry() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    return;
  }

  if (readingsCount == 0 && alertsCount == 0 && eventsCount == 0) {
    return;
  }

  WiFiClientSecure client;
  client.setInsecure(); // Supabase uses valid TLS certs; setInsecure avoids certificate pinning overhead on ESP32

  HTTPClient http;
  http.begin(client, INGEST_URL);
  http.setReuse(true);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_KEY);
  http.setTimeout(2500);

  // Construct JSON document
  StaticJsonDocument<1536> doc;
  doc["device_id"] = DEVICE_ID;
  int bat = readBatteryPct();
  if (bat >= 0) {
    doc["battery_pct"] = bat;
  }
  doc["baseline_angle"] = baselineAngle;

  JsonArray readingsArray = doc.createNestedArray("readings");
  for (int i = 0; i < readingsCount; i++) {
    JsonObject obj = readingsArray.createNestedObject();
    obj["ts"] = readingsBuffer[i].ts;
    obj["angle"] = serialized(String(readingsBuffer[i].angle, 1));
    obj["state"] = readingsBuffer[i].state;
    obj["movement"] = serialized(String(readingsBuffer[i].movement, 2));
  }

  JsonArray alertsArray = doc.createNestedArray("alerts");
  for (int i = 0; i < alertsCount; i++) {
    JsonObject obj = alertsArray.createNestedObject();
    obj["ts"] = alertsBuffer[i].ts;
    obj["level"] = alertsBuffer[i].level;
    obj["duration_s"] = alertsBuffer[i].duration_s;
    obj["reason"] = alertsBuffer[i].reason;
    obj["recovery_time_s"] = alertsBuffer[i].recovery_time_s;
  }

  JsonArray eventsArray = doc.createNestedArray("events");
  for (int i = 0; i < eventsCount; i++) {
    JsonObject obj = eventsArray.createNestedObject();
    obj["ts"] = eventsBuffer[i].ts;
    obj["type"] = eventsBuffer[i].type;
    obj["angle"] = eventsBuffer[i].angle;
  }

  String jsonStr;
  serializeJson(doc, jsonStr);

  int httpCode = http.POST(jsonStr);

  if (httpCode == 200) {
    Serial.print("[POST] OK 200 | readings:");
    Serial.print(readingsCount);
    Serial.print(" alerts:");
    Serial.print(alertsCount);
    Serial.print(" events:");
    Serial.println(eventsCount);
    // Reset buffers on success
    readingsCount = 0;
    alertsCount = 0;
    eventsCount = 0;
    backoffDelayMs = 1000; // Reset backoff
  } else {
    Serial.print("[POST] FAILED code:");
    Serial.print(httpCode);
    Serial.print(" response:");
    Serial.println(http.getString());
    // Retry with backoff delay
    backoffDelayMs = min(backoffDelayMs * 2, MAX_BACKOFF_MS);
  }

  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("=== SmartPosture AI - ESP32 Starting ===");

  // Configure I/O Pins
  pinMode(PIN_MOTOR, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_YELLOW, OUTPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  digitalWrite(PIN_MOTOR, LOW);
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_LED_RED, LOW);
  digitalWrite(PIN_LED_GREEN, LOW);

  // Turn ON Yellow LED to indicate device is powered ON and running
  digitalWrite(PIN_LED_YELLOW, HIGH);
  Serial.println("[LED] Yellow ON - Device is powered ON");

  // Init Sensors & Display
  initMPU6050();
  initOLED();

  // Connect Wi-Fi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[WiFi] Connecting to: ");
  Serial.print(WIFI_SSID);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WiFi] Connected! IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("[WiFi] FAILED to connect after 20 attempts!");
  }

  // Sync NTP Time
  configTime(gmtOffset_sec, daylightOffset_sec, ntpServer);
  Serial.println("[NTP] Time sync requested from pool.ntp.org");

  // Wait briefly for NTP
  delay(1500);
  struct tm timeinfo;
  if (getLocalTime(&timeinfo)) {
    char timeBuf[25];
    strftime(timeBuf, sizeof(timeBuf), "%Y-%m-%d %H:%M:%S", &timeinfo);
    Serial.print("[NTP] Current time: ");
    Serial.println(timeBuf);
  } else {
    Serial.println("[NTP] WARNING: Time not synced yet");
  }

  // Calibrate initial upright posture
  Serial.println("[CAL] Calibrating baseline angle...");
  calibrateBaseline();
  Serial.print("[CAL] Baseline angle set to: ");
  Serial.print(baselineAngle, 1);
  Serial.println(" degrees");

  Serial.println("=== Setup Complete - Entering Main Loop ===");
  Serial.print("[CFG] Ingest URL: ");
  Serial.println(INGEST_URL);
  Serial.print("[CFG] Device ID:  ");
  Serial.println(DEVICE_ID);
  Serial.println();
}

void loop() {
  unsigned long nowMs = millis();

  // 1. Check Calibration Push Button (Active LOW)
  if (digitalRead(PIN_BUTTON) == LOW) {
    delay(50); // Debounce
    if (digitalRead(PIN_BUTTON) == LOW) {
      calibrateBaseline();
      while (digitalRead(PIN_BUTTON) == LOW) delay(10);
    }
  }

  // 2. Sample IMU Tilt Angle & Movement
  readMPU6050(currentAngle, movementLevel);
  float diff = abs(currentAngle - baselineAngle);

  // 3. Posture State Classification & Alert Escalation (with 10-second Persistence Filter)
  if (diff >= BAD_DEG) {
    currentState = "bad";
  } else if (diff >= WARN_DEG) {
    currentState = "warning";
  } else {
    currentState = "good";
  }

  // Update 3 status LEDs: Red (Bad), Green (Good), Yellow (Device ON)
  updateLEDs(currentState);

  // Only trigger vibration/buzzer if poor posture (Warning or Bad) persists for >= 10 seconds.
  // Momentary posture shifts (1-9s) cause ZERO sound or vibration!
  if (diff >= WARN_DEG) {
    if (poorPostureStartMs == 0) {
      poorPostureStartMs = nowMs; // Start tracking duration in poor posture
    }

    unsigned long poorDurationS = (nowMs - poorPostureStartMs) / 1000;

    // After 10 continuous seconds of poor posture -> trigger Vibration Motor
    if (poorDurationS >= ALERT_DELAY_VIBRATION_S && !vibrationActive) {
      vibrationActive = true;
      digitalWrite(PIN_MOTOR, HIGH);
      alertStartMs = nowMs;
      Serial.print("[ALERT] 10s persistent poor posture (");
      Serial.print(poorDurationS);
      Serial.println("s) -> Vibration Motor ON");
    }

    // If posture is BAD and persists for another 5 seconds (total 15s) -> trigger Buzzer
    if (diff >= BAD_DEG && poorDurationS >= (ALERT_DELAY_VIBRATION_S + 5) && !buzzerActive) {
      buzzerActive = true;
      digitalWrite(PIN_BUZZER, HIGH);
      Serial.println("[ALERT] Sustained BAD posture -> Buzzer ON");
    }
  } else {
    // Posture is GOOD -> immediately stop all vibration and buzzer
    if (vibrationActive || buzzerActive) {
      digitalWrite(PIN_MOTOR, LOW);
      digitalWrite(PIN_BUZZER, LOW);

      // Record alert resolution
      if (alertsCount < 5) {
        char ts[25];
        getIsoTimestamp(ts, sizeof(ts));
        strncpy(alertsBuffer[alertsCount].ts, ts, sizeof(alertsBuffer[alertsCount].ts));
        strncpy(alertsBuffer[alertsCount].level, buzzerActive ? "buzzer" : "vibration", sizeof(alertsBuffer[alertsCount].level));
        alertsBuffer[alertsCount].duration_s = (nowMs - alertStartMs) / 1000;
        strncpy(alertsBuffer[alertsCount].reason, "forward_lean", sizeof(alertsBuffer[alertsCount].reason));
        alertsBuffer[alertsCount].recovery_time_s = alertsBuffer[alertsCount].duration_s;
        alertsCount++;
      }

      Serial.println("[ALERT] Posture corrected -> Vibration & Buzzer OFF");
    }

    // Reset alert states and timer
    vibrationActive = false;
    buzzerActive = false;
    poorPostureStartMs = 0;
  }

  // 4. Update OLED Display every 200ms for smooth real-time visual feedback
  static unsigned long lastOledMs = 0;
  if (nowMs - lastOledMs >= 200) {
    lastOledMs = nowMs;
    updateOLED();
  }

  // 5. Record sample every 1 second into buffer
  static unsigned long lastSampleMs = 0;
  if (nowMs - lastSampleMs >= 1000) {
    lastSampleMs = nowMs;
    if (readingsCount < MAX_BUFFER_SIZE) {
      getIsoTimestamp(readingsBuffer[readingsCount].ts, sizeof(readingsBuffer[readingsCount].ts));
      readingsBuffer[readingsCount].angle = currentAngle;
      strncpy(readingsBuffer[readingsCount].state, currentState.c_str(), sizeof(readingsBuffer[readingsCount].state));
      readingsBuffer[readingsCount].movement = movementLevel;
      readingsCount++;

      // Print live reading every second
      Serial.print("[LIVE] angle:");
      Serial.print(currentAngle, 1);
      Serial.print("° state:");
      Serial.print(currentState);
      Serial.print(" movement:");
      Serial.print(movementLevel, 2);
      Serial.println();
    }
  }

  // 5. Transmit batch to Cloud every 10 seconds
  if (nowMs - lastPostMs >= POST_INTERVAL_MS) {
    lastPostMs = nowMs;
    postTelemetry();
  }

  delay(50);
}
