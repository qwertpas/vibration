#include <Arduino.h>
#include <BLEDevice.h>
#include <Update.h>
#include <esp_ota_ops.h>

constexpr int pins[2][2] = {{10, 11}, {12, 13}};
constexpr uint32_t timeoutMs = 500;
int motors[2] = {};
uint32_t lastCommand = 0;
bool ready = false;
char line[80];
size_t length = 0;
bool overflow = false;
constexpr char serviceId[] = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
constexpr char commandId[] = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
constexpr char replyId[] = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
constexpr char updateId[] = "6e400004-b5a3-f393-e0a9-e50e24dcca9e";
BLECharacteristic *reply;
SemaphoreHandle_t lock;
bool bleConnected = false, restartAdvertising = false;
bool updating = false, updateFailed = false;
bool bleOwner = false;
uint32_t lastUpdate = 0, rebootAt = 0;

void drive(int motor, int value) {
    const int a = pins[motor][0], b = pins[motor][1];
    if ((motors[motor] < 0 && value > 0) || (motors[motor] > 0 && value < 0)) {
        ledcWrite(a, 0);
        ledcWrite(b, 0);
        delayMicroseconds(100);
    }
    // Turn off the opposite input before applying PWM.
    ledcWrite(value >= 0 ? b : a, 0);
    ledcWrite(value >= 0 ? a : b, abs(value) * 1023 / 100);
    motors[motor] = value;
}

void stop() {
    drive(0, 0);
    drive(1, 0);
}

void status(unsigned id, const char *error = "", bool ble = false) {
    char text[240];
    snprintf(text, sizeof(text), "{\"app\":\"vibration\",\"id\":%u,\"motors\":[%d,%d],"
                  "\"duty\":[%lu,%lu,%lu,%lu],\"slot\":%lu,\"error\":\"%s\"}\n",
                  id, motors[0], motors[1],
                  (unsigned long)ledcRead(10), (unsigned long)ledcRead(11),
                  (unsigned long)ledcRead(12), (unsigned long)ledcRead(13),
                  (unsigned long)esp_ota_get_running_partition()->address, error);
    if (!ble) { Serial.print(text); return; }
    auto server = BLEDevice::getServer();
    const size_t packetSize = server->getPeerMTU(server->getConnId()) - 3;
    const size_t size = strlen(text);
    // Use the negotiated MTU and let the BLE stack schedule transmission.
    for (size_t offset = 0; offset < size; offset += packetSize) {
        reply->setValue((uint8_t *)text + offset, min(packetSize, size - offset));
        reply->notify();
    }
}

void handle(const char *text, bool ble = false) {
    unsigned id = 0;
    int a, b, end = 0;
    unsigned size = 0;
    char md5[33] = {};
    if (ble && sscanf(text, "BEGIN %u %u %32s%n", &id, &size, md5, &end) == 3 &&
        text[end] == '\0' && strlen(md5) == 32 && size > 0 &&
        strspn(md5, "0123456789abcdef") == 32) {
        stop();
        if (updating || rebootAt) { status(id, "Update already started", ble); return; }
        updating = Update.begin(size);
        updateFailed = !updating;
        if (updating) Update.setMD5(md5);
        lastUpdate = millis();
        status(id, updating ? "" : "Cannot start update", ble);
        return;
    }
    if (ble && sscanf(text, "FINISH %u%n", &id, &end) == 1 && text[end] == '\0') {
        const bool success = updating && !updateFailed && Update.end();
        if (!success) Update.abort();
        updating = false;
        status(id, success ? "" : "Firmware verification failed", ble);
        if (success) rebootAt = millis() + 1000;
        return;
    }
    if (ble && sscanf(text, "ABORT %u%n", &id, &end) == 1 && text[end] == '\0') {
        Update.abort();
        updating = false;
        stop();
        status(id, "", ble);
        return;
    }
    if (sscanf(text, "STOP %u%n", &id, &end) == 1 && text[end] == '\0') {
        stop();
    } else if (sscanf(text, "GET %u%n", &id, &end) == 1 && text[end] == '\0') {
        // Status requests do not keep motors running.
    } else if (sscanf(text, "SET %u %d %d%n", &id, &a, &b, &end) == 3 &&
               text[end] == '\0' && a >= -100 && a <= 100 && b >= -100 && b <= 100 && ready) {
        if (updating || rebootAt) { status(id, "Firmware update in progress", ble); return; }
        if ((motors[0] || motors[1]) && ble != bleOwner) {
            status(id, "Other connection is controlling motors", ble);
            return;
        }
        bleOwner = ble;
        drive(0, a);
        drive(1, b);
        lastCommand = millis();
    } else {
        stop();
        status(id, ready ? "Invalid command" : "PWM setup failed", ble);
        return;
    }
    status(id, ready ? "" : "PWM setup failed", ble);
}

// BLE callbacks and the USB loop share the motor and update state under one lock.
class Commands : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *characteristic) override {
        String text = characteristic->getValue();
        text.trim();
        xSemaphoreTake(lock, portMAX_DELAY);
        handle(text.c_str(), true);
        xSemaphoreGive(lock);
    }
};

class Firmware : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *characteristic) override {
        const String data = characteristic->getValue();
        xSemaphoreTake(lock, portMAX_DELAY);
        if (updating && !updateFailed) {
            updateFailed = Update.write((uint8_t *)data.c_str(), data.length()) != data.length();
            lastUpdate = millis();
        }
        xSemaphoreGive(lock);
    }
};

class Connections : public BLEServerCallbacks {
    void onConnect(BLEServer *server, ble_gap_conn_desc *connection) override {
        // Request 15–30 ms intervals for responsive control and firmware transfer.
        server->updateConnParams(connection->conn_handle, 12, 24, 0, 200);
    }
    void onConnect(BLEServer *) override {
        xSemaphoreTake(lock, portMAX_DELAY);
        bleConnected = true;
        xSemaphoreGive(lock);
    }
    void onDisconnect(BLEServer *) override {
        xSemaphoreTake(lock, portMAX_DELAY);
        bleConnected = false;
        if (bleOwner) stop();
        if (updating) { Update.abort(); updating = false; }
        restartAdvertising = true;
        xSemaphoreGive(lock);
    }
};

void setup() {
    lock = xSemaphoreCreateMutex();
    for (const auto &pair : pins) {
        for (int pin : pair) {
            pinMode(pin, OUTPUT);
            digitalWrite(pin, LOW);
        }
    }
    ready = true;
    for (const auto &pair : pins) {
        for (int pin : pair) {
            if (!ledcAttach(pin, 20000, 10)) ready = false;
        }
    }
    stop();
    Serial.begin(115200);
    BLEDevice::init("Vibration");
    BLEDevice::setPower(ESP_PWR_LVL_N6);
    BLEDevice::setPower(ESP_PWR_LVL_N6, ESP_BLE_PWR_TYPE_ADV);
    BLEDevice::setMTU(517);
    BLEServer *server = BLEDevice::createServer();
    server->setCallbacks(new Connections());
    BLEService *service = server->createService(serviceId);
    reply = service->createCharacteristic(replyId, BLECharacteristic::PROPERTY_NOTIFY);
    service->createCharacteristic(commandId, BLECharacteristic::PROPERTY_WRITE)->setCallbacks(new Commands());
    service->createCharacteristic(updateId, BLECharacteristic::PROPERTY_WRITE)->setCallbacks(new Firmware());
    service->start();
    auto advertising = BLEDevice::getAdvertising();
    // Keep the full name in the primary packet so name-based discovery works.
    advertising->setName("Vibration");
    advertising->setScanResponse(true);
    advertising->start();
}

void loop() {
    xSemaphoreTake(lock, portMAX_DELAY);
    const bool lost = bleOwner ? !bleConnected : !Serial;
    if ((lost || millis() - lastCommand >= timeoutMs) && (motors[0] || motors[1])) stop();
    if (updating && millis() - lastUpdate > 10000) { Update.abort(); updating = false; }
    if (rebootAt && int32_t(millis() - rebootAt) >= 0) ESP.restart();
    const bool advertise = restartAdvertising;
    restartAdvertising = false;
    // Bound work so a noisy serial stream cannot starve the timeout.
    for (int i = 0; i < 160 && Serial.available(); ++i) {
        const char c = Serial.read();
        if (c == '\n') {
            line[length] = '\0';
            if (overflow) { stop(); status(0, "Command too long"); }
            else if (length) handle(line);
            length = 0;
            overflow = false;
        } else if (c != '\r') {
            if (length < sizeof(line) - 1) line[length++] = c;
            else overflow = true;
        }
    }
    xSemaphoreGive(lock);
    if (advertise) BLEDevice::startAdvertising();
    delay(1);
}
