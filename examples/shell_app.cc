
#include "runtime_client_api.h"

static const char* SHELL_APP_URL = "https://www.pwaos.net/shell/";

extern "C" {

int pwaMain(PWAOS_SERVICE_HANDLE handle) {
  char out_app_id[MAX_APP_ID_LEN];
  return pwaosCreatePwa(handle, appTypeConsole, SHELL_APP_URL, out_app_id);
}

}