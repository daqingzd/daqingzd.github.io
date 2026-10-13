#include "runtime_client_api.h"

#include <stdio.h>
#include <stdlib.h>

#include <chrono>
#include <thread>

static const char* SHELL_APP_URL = "https://www.pwaos.net/shell/";
static PWAOS_APP_HANDLE appHandle = INVALID_PWAOS_HANDLE;

extern "C" {

pwaosResult pwaMain(PWAOS_INSTANCE_HANDLE instanceHandle) {
  printf("starting...\n");

  pwaosAppCreateInfo createInfo {PWAOS_TYPE_PWA_CREATE_INFO, nullptr,
                                 appTypeConsole, SHELL_APP_URL, 800, 600};
  auto result = pwaosInstance_createPwa(instanceHandle, &createInfo, &appHandle);
  if (result != PWAOS_RESULT_SUCCESS) {
    char err_str_buffer[PWAOS_MAX_RESULT_NAME_SIZE];
    pwaos_resultToString(result, err_str_buffer);
    printf("pwaosInstance_createPwa failed: %s\n", err_str_buffer);
    return result;
  }

  do {
    pwaosEventDataBuffer buffer;
    if (PWAOS_RESULT_SUCCESS == pwaosInstance_pollEvent(instanceHandle, &buffer)) {
      if (buffer.type == PWAOS_TYPE_EVENT_DATA_INSTANCE_STATUS_CHANGED) {
        auto& event = reinterpret_cast<pwaosEventDataInstanceStatusChanged&>(buffer);
        if (event.instance == instanceHandle) {
          if (event.status < 0)
            break;
        }
      } else if (buffer.type == PWAOS_TYPE_EVENT_DATA_APP_STATUS_CHANGED) {
        auto& event = reinterpret_cast<pwaosEventDataAppStatusChanged&>(buffer);
        if (event.app == appHandle) {
          if (event.status == appStatusStopping)
            break;
        }
      }
    } else {
      auto abs_time = std::chrono::steady_clock::now() + std::chrono::milliseconds(10);
      std::this_thread::sleep_until(abs_time);
    }

  } while(true);

  printf("exitting...\n");
  pwaosInstance_destroyPwa(appHandle);
  return PWAOS_RESULT_SUCCESS;
}

}
