import {ESPError, TimeoutError} from "./error.js";
import pako from 'pako';

const MAGIC_TO_CHIP = {
    [0x00f01d83]: () => import('./targets/esp32.js'),
    [0x6921506f]: () => import('./targets/esp32c3.js'),  // ESP32C3 eco 1+2
    [0x1b31506f]: () => import('./targets/esp32c3.js'),  // ESP32C3 eco3
    [0x09]: () => import('./targets/esp32s3.js'),
    [0x000007c6]: () => import('./targets/esp32s2.js'),
    [0xfff0c101]: () => import('./targets/esp8266.js'),
 }

class ESPLoader {
    ESP_RAM_BLOCK = 0x1800;
    ESP_FLASH_BEGIN = 0x02;
    ESP_FLASH_DATA = 0x03;
    ESP_FLASH_END = 0x04;
    ESP_MEM_BEGIN  = 0x05;
    ESP_MEM_END = 0x06;
    ESP_MEM_DATA = 0x07;
    ESP_WRITE_REG = 0x09;
    ESP_READ_REG = 0x0A;

    ESP_SPI_ATTACH = 0x0D;
    ESP_CHANGE_BAUDRATE = 0x0F;
    ESP_FLASH_DEFL_BEGIN = 0x10;
    ESP_FLASH_DEFL_DATA  = 0x11;
    ESP_FLASH_DEFL_END   = 0x12;
    ESP_SPI_FLASH_MD5    = 0x13;

    // Only Stub supported commands
    ESP_ERASE_FLASH = 0xD0;
    ESP_ERASE_REGION = 0xD1;
    ESP_RUN_USER_CODE = 0xD3;

    ESP_IMAGE_MAGIC = 0xe9;
    ESP_CHECKSUM_MAGIC = 0xef;

    // Response code(s) sent by ROM
    ROM_INVALID_RECV_MSG = 0x05   // response if an invalid message is received

    ERASE_REGION_TIMEOUT_PER_MB = 30000;
    ERASE_WRITE_TIMEOUT_PER_MB = 40000;
    MD5_TIMEOUT_PER_MB = 8000;
    CHIP_ERASE_TIMEOUT = 120000;
    MAX_TIMEOUT = this.CHIP_ERASE_TIMEOUT * 2;

    CHIP_DETECT_MAGIC_REG_ADDR = 0x40001000;

    DETECTED_FLASH_SIZES = {0x12: '256KB', 0x13: '512KB', 0x14: '1MB', 0x15: '2MB', 0x16: '4MB', 0x17: '8MB', 0x18: '16MB'};

    constructor(transport, baudrate, terminal) {
        this.transport = transport;
        this.baudrate = baudrate;
        this.terminal = terminal;
        this.IS_STUB = false;
        this.chip = null;

        if (terminal) {
            this.terminal.clear();
        }

        this.log("esptool.js v0.1-dev");
        this.log("Serial port " + this.transport.get_info());
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    log(str) {
        if (this.terminal) {
            this.terminal.writeln(str);
        } else {
            console.log(str);
        }
    }
    write_char(str) {
        if (this.terminal) {
            this.terminal.write(str);
        } else {
            console.log(str);
        }
    }
    _short_to_bytearray(i) {
        return [i & 0xff, (i >> 8) & 0xff];
    }

    _int_to_bytearray(i) {
        return [i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff, (i >> 24) & 0xff];
    }

    _bytearray_to_short(i, j) {
        return (i | (j >> 8));
    }

    _bytearray_to_int(i, j, k, l) {
        return (i | (j << 8) | (k << 16) | (l << 24));
    }

    _appendBuffer(buffer1, buffer2) {
        var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
        tmp.set(new Uint8Array(buffer1), 0);
        tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
        return tmp.buffer;
    }

    _appendArray(arr1, arr2) {
        var c = new Uint8Array(arr1.length + arr2.length);
        c.set(arr1, 0);
        c.set(arr2, arr1.length);
        return c;
    }

    ui8ToBstr(u8Array) {
        var i, len = u8Array.length, b_str = "";
        for (i=0; i<len; i++) {
            b_str += String.fromCharCode(u8Array[i]);
        }
        return b_str;
    }

    bstrToUi8(bStr) {
        var i, len = bStr.length, u8_array = new Uint8Array(len);
        for (var i = 0; i < len; i++) {
            u8_array[i] = bStr.charCodeAt(i);
        }
        return u8_array;
    }

    async flush_input() {
        try {
            await this.transport.readRaw({timeout:200});
        } catch(e) {
        }
    }

    async command({op=null, data=[], chk=0, wait_response=true, timeout=3000} = {})  {
        //console.log("command "+ op + " " + wait_response + " " + timeout);
        if (op != null) {
            var pkt = new Uint8Array(8 + data.length);
            pkt[0] = 0x00;
            pkt[1] = op;
            pkt[2] = this._short_to_bytearray(data.length)[0];
            pkt[3] = this._short_to_bytearray(data.length)[1];
            pkt[4] = this._int_to_bytearray(chk)[0];
            pkt[5] = this._int_to_bytearray(chk)[1];
            pkt[6] = this._int_to_bytearray(chk)[2];
            pkt[7] = this._int_to_bytearray(chk)[3];

            var i;
            for (i = 0; i < data.length; i++) {
                pkt[8 + i] = data[i];
            }
            //console.log("Command " + pkt);
            await this.transport.write(pkt);
        }

        if (wait_response) {
            // Check up-to next 100 packets for valid response packet
            for (let i=0 ; i<100 ; i++) {
                var p = await this.transport.read({timeout: timeout});
                //console.log("Response " + p);
                const resp = p[0];
                const op_ret = p[1];
                const len_ret = this._bytearray_to_short(p[2], p[3]);
                const val = this._bytearray_to_int(p[4], p[5], p[6], p[7]);
                //console.log("Resp "+resp + " " + op_ret + " " + len_ret + " " + val );
                const data = p.slice(8);
                if (resp == 1) {
                    if (op == null || op_ret == op) {
                        return [val, data];
                    } else if (data[0] != 0 && data[1] == this.ROM_INVALID_RECV_MSG) {
                        await this.flush_input();
                        throw new ESPError("unsupported command error");
                    }
                }
            }
            throw new ESPError("invalid response")
        }
    }

    async read_reg({addr, timeout = 3000} = {}) {
        var val, data;
        var pkt = this._int_to_bytearray(addr);
        val = await this.command({op:this.ESP_READ_REG, data:pkt, timeout:timeout});
        return val[0];
    }

    async write_reg({addr, value, mask = 0xFFFFFFFF, delay_us = 0, delay_after_us = 0} = {}) {
        var pkt = this._appendArray(this._int_to_bytearray(addr), this._int_to_bytearray(value));
        pkt = this._appendArray(pkt, this._int_to_bytearray(mask));
        pkt = this._appendArray(pkt, this._int_to_bytearray(delay_us));

        if (delay_after_us > 0) {
            pkt = this._appendArray(pkt, this._int_to_bytearray(this.chip.UART_DATE_REG_ADDR));
            pkt = this._appendArray(pkt, this._int_to_bytearray(0));
            pkt = this._appendArray(pkt, this._int_to_bytearray(0));
            pkt = this._appendArray(pkt, this._int_to_bytearray(delay_after_us));
        }

        await this.check_command({op_description: "write target memory", op: this.ESP_WRITE_REG, data: pkt});
    }

    async sync() {
        console.log("Sync");
        var cmd = new Uint8Array(36);
        var i;
        cmd[0] = 0x07;
        cmd[1] = 0x07;
        cmd[2] = 0x12;
        cmd[3] = 0x20;
        for (i = 0; i < 32; i++) {
            cmd[4 + i] = 0x55;
        }

        try {
            const resp = await this.command({op:0x08, data:cmd, timeout:100});
            return resp;
        } catch(e) {
            console.log("Sync err " + e);
            throw e;
        }
    }

    async _connect_attempt({mode='default_reset', esp32r0_delay=false} = {}) {
        console.log("_connect_attempt " + mode + " " + esp32r0_delay);
        if (mode !== 'no_reset') {
            await this.transport.setDTR(false);
            await this.transport.setRTS(true);
            await this._sleep(100);
            if (esp32r0_delay) {
                //await this._sleep(1200);
                await this._sleep(2000);
            }
            await this.transport.setDTR(true);
            await this.transport.setRTS(false);
            if (esp32r0_delay) {
                //await this._sleep(400);
            }
            await this._sleep(50);
            await this.transport.setDTR(false);
        }
        var i = 0;
        while (1) {
            try {
                const res = await this.transport.read({timeout: 1000});
                i += res.length;
                //console.log("Len = " + res.length);
                //var str = new TextDecoder().decode(res);
                //this.log(str);
            } catch (e) {
                if (e instanceof TimeoutError) {
                    break;
                }
            }
            await this._sleep(50);
        }
        this.transport.slip_reader_enabled = true;
        var i = 7;
        while (i--) {
            try {
                var resp = await this.sync();
                return "success";
            } catch(error) {
                if (error instanceof TimeoutError) {
                    if (esp32r0_delay) {
                        this.write_char('_');
                    } else {
                        this.write_char('.');
                    }
                }
            }
            await this._sleep(50);
        }
        return "error";
    }

    async connect({mode='default_reset', attempts=7, detecting=false} = {}) {
        var i;
        var resp;
        this.chip = null;
        this.write_char('Connecting...');
        await this.transport.connect();
        for (i = 0 ; i < attempts; i++) {
            resp = await this._connect_attempt({mode:mode, esp32r0_delay:false});
            if (resp === "success") {
                break;
            }
            resp = await this._connect_attempt({mode:mode, esp32r0_delay:true});
            if (resp === "success") {
                break;
            }
        }
        if (resp !== "success") {
            throw new ESPError("Failed to connect with the device");
        }
        this.write_char('\n');
        this.write_char('\r');
        await this.flush_input();

        if (!detecting) {
            var chip_magic_value = await this.read_reg({addr:0x40001000}) >>> 0;
            console.log("Chip Magic " + chip_magic_value.toString(16));

            if (chip_magic_value in MAGIC_TO_CHIP) {
                this.chip = (await MAGIC_TO_CHIP[chip_magic_value]()).default;
            } else {
                throw new ESPError(`Unexpected CHIP magic value ${chip_magic_value}. Failed to autodetect chip type.`);
            }
        }
     }


    async detect_chip({mode='default_reset'} = {}) {
        await this.connect({mode:mode});
        this.write_char("Detecting chip type... ");
        if (this.chip != null) {
            this.log(this.chip.CHIP_NAME);
        }
    }

    async check_command({op_description="", op=null, data=[], chk=0, timeout=3000} = {}) {
        console.log("check_command " + op_description) ;
        var resp = await this.command({op:op, data:data, chk:chk, timeout:timeout});
        if (resp[1].length > 4) {
            return resp[1];
        } else {
            return resp[0];
        }
    }

    async mem_begin(size, blocks, blocksize, offset) {
        /* XXX: Add check to ensure that STUB is not getting overwritten */
        console.log("mem_begin " + size + " " + blocks + " " + blocksize + " " + offset.toString(16));
        var pkt = this._appendArray(this._int_to_bytearray(size), this._int_to_bytearray(blocks));
        pkt = this._appendArray(pkt, this._int_to_bytearray(blocksize));
        pkt = this._appendArray(pkt, this._int_to_bytearray(offset));
        await this.check_command({op_description: "enter RAM download mode", op: this.ESP_MEM_BEGIN, data: pkt});
    }

    checksum = function (data) {
        var i;
        var chk = 0xEF;

        for (i = 0; i < data.length; i++) {
            chk ^= data[i];
        }
        return chk;
    }

    async mem_block(buffer, seq) {
        var pkt = this._appendArray(this._int_to_bytearray(buffer.length), this._int_to_bytearray(seq));
        pkt = this._appendArray(pkt, this._int_to_bytearray(0));
        pkt = this._appendArray(pkt, this._int_to_bytearray(0));
        pkt = this._appendArray(pkt, buffer);
        var checksum = this.checksum(buffer);
        await this.check_command({op_description: "write to target RAM", op: this.ESP_MEM_DATA, data: pkt, chk: checksum});
    }

    async mem_finish(entrypoint) {
        var is_entry = (entrypoint === 0) ? 1 : 0;
        var pkt = this._appendArray(this._int_to_bytearray(is_entry), this._int_to_bytearray(entrypoint));
        await this.check_command({op_description: "leave RAM download mode", op: this.ESP_MEM_END, data: pkt, timeout: 50}); // XXX: handle non-stub with diff timeout
    }

    async flash_spi_attach(hspi_arg) {
        var pkt = this._int_to_bytearray(hspi_arg);
        await this.check_command({op_description: "configure SPI flash pins", op: this.ESP_SPI_ATTACH, data: pkt});
    }

    timeout_per_mb = function(seconds_per_mb, size_bytes) {
        var result = seconds_per_mb * (size_bytes / 1000000);
        if (result < 3000) {
            return 3000;
        } else {
            return result;
        }
    }

    async flash_begin(size, offset) {
        var num_blocks = Math.floor((size + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE);
        var erase_size = this.chip.get_erase_size(offset, size);

        var d = new Date();
        var t1 = d.getTime();

        var timeout = 3000;
        if (this.IS_STUB == false) {
            timeout = this.timeout_per_mb(this.ERASE_REGION_TIMEOUT_PER_MB, size);
        }

        console.log("flash begin " + erase_size + " " + num_blocks + " " + this.FLASH_WRITE_SIZE + " " + offset + " " + size);
        var pkt = this._appendArray(this._int_to_bytearray(erase_size), this._int_to_bytearray(num_blocks));
        pkt = this._appendArray(pkt, this._int_to_bytearray(this.FLASH_WRITE_SIZE));
        pkt = this._appendArray(pkt, this._int_to_bytearray(offset));
        if (this.IS_STUB == false) {
            pkt = this._appendArray(pkt, this._int_to_bytearray(0)); // XXX: Support encrypted
        }

        await this.check_command({op_description:"enter Flash download mode", op: this.ESP_FLASH_BEGIN, data: pkt, timeout: timeout});

        var t2 = d.getTime();
        if (size != 0 && this.IS_STUB == false) {
            this.log("Took "+((t2-t1)/1000)+"."+((t2-t1)%1000)+"s to erase flash block");
        }
        return num_blocks;
    }

    async flash_defl_begin(size, compsize, offset) {
        var num_blocks = Math.floor((compsize + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE);
        var erase_blocks = Math.floor((size + this.FLASH_WRITE_SIZE - 1) / this.FLASH_WRITE_SIZE);

        var d = new Date();
        var t1 = d.getTime();

        let write_size, timeout;
        if (this.IS_STUB) {
            write_size = size;
            timeout = 3000;
        } else {
            write_size = erase_blocks * this.FLASH_WRITE_SIZE;
            timeout = this.timeout_per_mb(this.ERASE_REGION_TIMEOUT_PER_MB, write_size);
        }
        this.log("Compressed " + size + " bytes to " + compsize + "...");

        var pkt = this._appendArray(this._int_to_bytearray(write_size), this._int_to_bytearray(num_blocks));
        pkt = this._appendArray(pkt, this._int_to_bytearray(this.FLASH_WRITE_SIZE));
        pkt = this._appendArray(pkt, this._int_to_bytearray(offset));

        if ((this.chip.CHIP_NAME === "ESP32-S2" || this.chip.CHIP_NAME === "ESP32-S3" || this.chip.CHIP_NAME === "ESP32-C3") && (this.IS_STUB === false)) {
            pkt = this._appendArray(pkt, this._int_to_bytearray(0));
        }
        await this.check_command({op_description:"enter compressed flash mode", op:this.ESP_FLASH_DEFL_BEGIN, data:pkt, timeout:timeout});
        var t2 = d.getTime();
        if (size != 0 && this.IS_STUB === false) {
            this.log("Took "+((t2-t1)/1000)+"."+((t2-t1)%1000)+"s to erase flash block");
        }
        return num_blocks;
    }

    async flash_block(data, seq, timeout) {
        var pkt = this._appendArray(this._int_to_bytearray(data.length), this._int_to_bytearray(seq));
        pkt = this._appendArray(pkt, this._int_to_bytearray(0));
        pkt = this._appendArray(pkt, this._int_to_bytearray(0));
        pkt = this._appendArray(pkt, data);

        var checksum = this.checksum(data);

        await this.check_command({op_description:"write to target Flash after seq " + seq, op: this.ESP_FLASH_DATA, data: pkt, chk: checksum, timeout: timeout});
    }

    async flash_defl_block(data, seq, timeout) {
        var pkt = this._appendArray(this._int_to_bytearray(data.length), this._int_to_bytearray(seq));
        pkt = this._appendArray(pkt, this._int_to_bytearray(0));
        pkt = this._appendArray(pkt, this._int_to_bytearray(0));
        pkt = this._appendArray(pkt, data);

        var checksum = this.checksum(data);
        console.log("flash_defl_block " + data[0].toString(16), + " " + data[1].toString(16));

        await this.check_command({op_description:"write compressed data to flash after seq " + seq, op: this.ESP_FLASH_DEFL_DATA, data: pkt, chk: checksum, timeout: timeout});

    }

    async flash_finish({reboot = false } = {}) {
        var val = reboot ? 0 : 1;
        var pkt = this._int_to_bytearray(val);

        await this.check_command({op_description:"leave Flash mode", op: this.ESP_FLASH_END, data: pkt});
    }

    async flash_defl_finish({reboot = false } = {}) {
        var val = reboot ? 0 : 1;
        var pkt = this._int_to_bytearray(val);

        await this.check_command({op_description:"leave compressed flash mode", op: this.ESP_FLASH_DEFL_END, data: pkt});
    }

    async run_spiflash_command(spiflash_command, data, read_bits) {
        // SPI_USR register flags
        var SPI_USR_COMMAND = (1 << 31);
        var SPI_USR_MISO    = (1 << 28);
        var SPI_USR_MOSI    = (1 << 27);

        // SPI registers, base address differs ESP32* vs 8266
        var base = this.chip.SPI_REG_BASE;
        var SPI_CMD_REG = base + 0x00;
        var SPI_USR_REG       = base + this.chip.SPI_USR_OFFS;
        var SPI_USR1_REG      = base + this.chip.SPI_USR1_OFFS;
        var SPI_USR2_REG      = base + this.chip.SPI_USR2_OFFS;
        var SPI_W0_REG        = base + this.chip.SPI_W0_OFFS;

        var set_data_lengths;
        if (this.chip.SPI_MOSI_DLEN_OFFS != null) {
            set_data_lengths = async(mosi_bits, miso_bits) => {
                var SPI_MOSI_DLEN_REG = base + this.chip.SPI_MOSI_DLEN_OFFS;
                var SPI_MISO_DLEN_REG = base + this.chip.SPI_MISO_DLEN_OFFS;
                if (mosi_bits > 0) {
                    await this.write_reg({addr:SPI_MOSI_DLEN_REG, value:(mosi_bits - 1)});
                }
                if (miso_bits > 0) {
                    await this.write_reg({addr:SPI_MISO_DLEN_REG, value:(miso_bits - 1)});
                }
            };
        } else {
            set_data_lengths = async(mosi_bits, miso_bits) => {
                var SPI_DATA_LEN_REG = SPI_USR1_REG;
                var SPI_MOSI_BITLEN_S = 17;
                var SPI_MISO_BITLEN_S = 8;
                var mosi_mask = (mosi_bits === 0) ? 0 : (mosi_bits - 1);
                var miso_mask = (miso_bits === 0) ? 0 : (miso_bits - 1);
                var val = (miso_mask << SPI_MISO_BITLEN_S) | (mosi_mask << SPI_MOSI_BITLEN_S);
                await this.write_reg({addr:SPI_DATA_LEN_REG, value:val});
            };
        }

        var SPI_CMD_USR  = (1 << 18);
        var SPI_USR2_COMMAND_LEN_SHIFT = 28;
        if(read_bits > 32) {
            throw new ESPError("Reading more than 32 bits back from a SPI flash operation is unsupported");
        }
        if (data.length > 64) {
            throw new ESPError("Writing more than 64 bytes of data with one SPI command is unsupported");
        }

        var data_bits = data.length * 8;
        var old_spi_usr = await this.read_reg({addr:SPI_USR_REG});
        var old_spi_usr2 = await this.read_reg({addr:SPI_USR2_REG});
        var flags = SPI_USR_COMMAND;
        var i;
        if (read_bits > 0) {
            flags |= SPI_USR_MISO;
        }
        if (data_bits > 0) {
            flags |= SPI_USR_MOSI;
        }
        await set_data_lengths(data_bits, read_bits);
        await this.write_reg({addr:SPI_USR_REG, value:flags});
        var val = (7 << SPI_USR2_COMMAND_LEN_SHIFT) | spiflash_command;
        await this.write_reg({addr:SPI_USR2_REG, value:val});
        if (data_bits == 0) {
            await this.write_reg({addr:SPI_W0_REG, value:0});
        } else {
            if (data.length % 4 != 0) {
                var padding = new Uint8Array(data.length % 4);
                data = this._appendArray(data, padding);
            }
            var next_reg = SPI_W0_REG;
            for (i = 0 ; i < data.length - 4; i+=4) {
                val = this._bytearray_to_int(data[i], data[i+1], data[i+2], data[i+3]);
                await this.write_reg({addr:next_reg, value:val});
                next_reg += 4;
            }
        }
        await this.write_reg({addr:SPI_CMD_REG, value:SPI_CMD_USR});
        for (i = 0; i < 10; i++) {
            val = await this.read_reg({addr:SPI_CMD_REG}) & SPI_CMD_USR;
            if (val == 0) {
                break;
            }
        }
        if (i === 10) {
            throw new ESPError("SPI command did not complete in time");
        }
        var stat = await this.read_reg({addr:SPI_W0_REG});
        await this.write_reg({addr:SPI_USR_REG, value:old_spi_usr});
        await this.write_reg({addr:SPI_USR2_REG, value:old_spi_usr2});
        return stat;
    }

    async read_flash_id() {
        var SPIFLASH_RDID = 0x9F;
        var pkt = new Uint8Array(0);
        return await this.run_spiflash_command(SPIFLASH_RDID, pkt, 24);
    }

    async erase_flash() {
        this.log("Erasing flash (this may take a while)...");
        var d = new Date();
        let t1 = d.getTime();
        let ret = await this.check_command({op_description:"erase flash", op: this.ESP_ERASE_FLASH, timeout: this.CHIP_ERASE_TIMEOUT});
        d = new Date();
        let t2 = d.getTime();
        this.log("Chip erase completed successfully in " + (t2-t1)/1000 + "s");
        return ret;
    }

    toHex(buffer) {
        return Array.prototype.map.call(buffer, x => ('00' + x.toString(16)).slice(-2)).join('');
    }

    async flash_md5sum(addr, size) {
        let timeout = this.timeout_per_mb(this.MD5_TIMEOUT_PER_MB, size);
        var pkt = this._appendArray(this._int_to_bytearray(addr), this._int_to_bytearray(size));
        pkt = this._appendArray(pkt, this._int_to_bytearray(0));
        pkt = this._appendArray(pkt, this._int_to_bytearray(0));

        let res = await this.check_command({op_description: "calculate md5sum", op: this.ESP_SPI_FLASH_MD5, data:pkt, timeout:timeout});
        if (res.length > 16) {
            res = res.slice(0, 16);
        }
        let strmd5 = this.toHex(res);
        return strmd5;
    }

    async run_stub() {
        this.log("Uploading stub...");

        var decoded = atob(this.chip.ROM_TEXT);
        var chardata = decoded.split('').map(function(x){return x.charCodeAt(0);});
        var bindata = new Uint8Array(chardata);
        var text = pako.inflate(bindata);

        decoded = atob(this.chip.ROM_DATA);
        chardata = decoded.split('').map(function(x){return x.charCodeAt(0);});
        var data = new Uint8Array(chardata);

        var blocks = Math.floor((text.length + this.ESP_RAM_BLOCK - 1) / this.ESP_RAM_BLOCK);
        var i;

        await this.mem_begin(text.length, blocks, this.ESP_RAM_BLOCK, this.chip.TEXT_START);
        for (i = 0; i < blocks; i++) {
            var from_offs = i * this.ESP_RAM_BLOCK;
            var to_offs = from_offs + this.ESP_RAM_BLOCK;
            await this.mem_block(text.slice(from_offs, to_offs), i);
        }

        blocks = Math.floor((data.length + this.ESP_RAM_BLOCK - 1) / this.ESP_RAM_BLOCK);
        await this.mem_begin(data.length, blocks, this.ESP_RAM_BLOCK, this.chip.DATA_START);
        for (i = 0; i < blocks; i++) {
            var from_offs = i * this.ESP_RAM_BLOCK;
            var to_offs = from_offs + this.ESP_RAM_BLOCK;
            await this.mem_block(data.slice(from_offs, to_offs), i);
        }

        this.log("Running stub...");
        await this.mem_finish(this.chip.ENTRY);

        // Check up-to next 100 packets to see if stub is running
        for (let i=0 ; i<100 ; i++) {
            const res = await this.transport.read({timeout: 1000, min_data: 6});
            if (res[0] === 79 && res[1] === 72 && res[2] === 65 && res[3] === 73) {
                this.log("Stub running...");
                this.IS_STUB = true;
                this.FLASH_WRITE_SIZE = 0x4000;
                return this.chip;
            }
        }
        throw new ESPError("Failed to start stub. Unexpected response");
    }

    async change_baud() {
        this.log("Changing baudrate to " + this.baudrate);
        let second_arg = this.IS_STUB ? this.transport.baudrate : 0;
        let pkt = this._appendArray(this._int_to_bytearray(this.baudrate), this._int_to_bytearray(second_arg));
        let resp = await this.command({op:this.ESP_CHANGE_BAUDRATE, data:pkt});
        this.log("Changed");
        await this.transport.disconnect();
        await this._sleep(50);
        await this.transport.connect({baud:this.baudrate});
        try {
            await this.transport.rawRead({timeout:500});
        } catch (e) {
        }
    }

    async main_fn({mode='default_reset'} = {}) {
        await this.detect_chip({mode});

        var chip = await this.chip.get_chip_description(this);
        this.log("Chip is " + chip);
        this.log("Features: " + await this.chip.get_chip_features(this));
        this.log("Crystal is " + await this.chip.get_crystal_freq(this) + "MHz");
        this.log("MAC: " + await this.chip.read_mac(this));
        await this.chip.read_mac(this);

        if (typeof(this.chip._post_connect) != 'undefined') {
            await this.chip._post_connect(this);
        }

        await this.run_stub();

        await this.change_baud();
        return chip;
    }

    flash_size_bytes = function(flash_size) {
        let flash_size_b = -1;
        if (flash_size.indexOf("KB") !== -1) {
            flash_size_b = parseInt(flash_size.slice(0, flash_size.indexOf("KB")))*1024;
        } else if (flash_size.indexOf("MB") !== -1) {
            flash_size_b = parseInt(flash_size.slice(0, flash_size.indexOf("MB")))*1024*1024;
        }
        return flash_size_b;
    }

    parse_flash_size_arg = function(flsz) {
        if (typeof this.chip.FLASH_SIZES[flsz] === 'undefined') {
            throw new ESPError("Flash size " + flsz + " is not supported by this chip type. Supported sizes: " + this.chip.FLASH_SIZES);
        }
        return this.chip.FLASH_SIZES[flsz];
    }

    _update_image_flash_params = function(image, address, flash_size, flash_mode, flash_freq) {
        console.log("_update_image_flash_params " + flash_size + " " + flash_mode + " " + flash_freq);
        if (image.length < 8) {
            return image;
        }
        if (address != this.chip.BOOTLOADER_FLASH_OFFSET) {
            return image;
        }
        if (flash_size === 'keep' && flash_mode === 'keep' && flash_freq === 'keep') {
            console.log("Not changing the image");
            return image;
        }

        let magic = image[0];
        let a_flash_mode = image[2];
        let flash_size_freq = image[3];
        if (magic !== this.ESP_IMAGE_MAGIC) {
            this.log("Warning: Image file at 0x" + address.toString(16) + " doesn't look like an image file, so not changing any flash settings.");
            return image;
        }

        /* XXX: Yet to implement actual image verification */

        if (flash_mode !== 'keep') {
            let flash_modes =  {'qio':0, 'qout':1, 'dio':2, 'dout':3};
            a_flash_mode =  flash_modes[flash_mode];
        }
        let a_flash_freq = flash_size_freq & 0x0F;
        if (flash_freq !== 'keep') {
            let flash_freqs = {'40m': 0, '26m': 1, '20m': 2, '80m': 0xf};
            a_flash_freq = flash_freqs[flash_freq];
        }
        let a_flash_size = flash_size_freq & 0xF0;
        if (flash_size !== 'keep') {
            a_flash_size = this.parse_flash_size_arg(flash_size);
        }

        var flash_params = (a_flash_mode << 8) | (a_flash_freq + a_flash_size);
        this.log("Flash params set to " + flash_params.toString(16));
        if (image[2] !== (a_flash_mode << 8)) {
            image[2] = (a_flash_mode << 8);
        }
        if (image[3] !== (a_flash_freq + a_flash_size)) {
            image[3] = (a_flash_freq + a_flash_size);
        }
        return image;
    }

    async write_flash({
        fileArray=[],
        flash_size='keep',
        flash_mode='keep',
        flash_freq='keep',
        erase_all=false,
        compress=true,
        /* function(fileIndex, written, total) */
        reportProgress=undefined,
        /* function(image: string) => string */
        calculateMD5Hash=undefined
    }) {
        console.log("EspLoader program");
        if (flash_size !== 'keep') {
            let flash_end = this.flash_size_bytes(flash_size);
            for (var i = 0; i < fileArray.length; i++) {
                if ((fileArray[i].data.length + fileArray[i].address) > flash_end) {
                    throw new ESPError(`File ${i + 1} doesn't fit in the available flash`);
                }
            }
        }

        if (this.IS_STUB === true && erase_all === true) {
            await this.erase_flash();
        }
        let image, address;
        for (var i = 0; i < fileArray.length; i++) {
            console.log("Data Length " + fileArray[i].data.length);
            image = fileArray[i].data + '\xff\xff\xff\xff'.substring(0, 4 - fileArray[i].data.length % 4);
            address = fileArray[i].address;
            console.log("Image Length " + image.length);
            if (image.length === 0) {
                this.log("Warning: File is empty");
                continue;
            }
            image = this._update_image_flash_params(image, address, flash_size, flash_mode, flash_freq);
            let calcmd5;
            if (calculateMD5Hash) {
                calcmd5 = calculateMD5Hash(image);
                console.log("Image MD5 " + calcmd5);
            }
            let uncsize = image.length;
            let blocks;
            if (compress) {
                let uncimage = this.bstrToUi8(image);
                image = pako.deflate(uncimage, {level:9});
                console.log("Compressed image ");
                console.log(image);
                blocks = await this.flash_defl_begin(uncsize, image.length, address);
            } else {
                blocks = await this.flash_begin(uncsize, address);
            }
            let seq = 0;
            let bytes_sent = 0;
            let bytes_written = 0;
            const totalBytes = image.length;
            if (reportProgress) reportProgress(i, 0, totalBytes);

            var d = new Date();
            let t1 = d.getTime();

            let timeout = 5000;
            while (image.length > 0) {
                console.log("Write loop " + address + " " + seq + " " + blocks);
                this.log("Writing at 0x" + (address + (seq * this.FLASH_WRITE_SIZE)).toString(16) + "... ("+ Math.floor(100 * (seq + 1) / blocks) + "%)");
                let block = image.slice(0, this.FLASH_WRITE_SIZE);
                if (compress) {
                    /*
                    let block_uncompressed = pako.inflate(block).length;
                    //let len_uncompressed = block_uncompressed.length;
                    bytes_written += block_uncompressed;
                    if (this.timeout_per_mb(this.ERASE_WRITE_TIMEOUT_PER_MB, block_uncompressed) > 3000) {
                        block_timeout = this.timeout_per_mb(this.ERASE_WRITE_TIMEOUT_PER_MB, block_uncompressed);
                    } else {
                        block_timeout = 3000;
                    }*/ // XXX: Partial block inflate seems to be unsupported in Pako. Hardcoding timeout
                    let block_timeout = 5000;
                    if (this.IS_STUB === false) {
                        timeout = block_timeout;
                    }
                    await this.flash_defl_block(block, seq, timeout);
                    if (this.IS_STUB) {
                        timeout = block_timeout;
                    }
                } else {
                    throw new ESPError("Yet to handle Non Compressed writes");
                }
                bytes_sent += block.length;
                image = image.slice(this.FLASH_WRITE_SIZE, image.length);
                seq++;
                if (reportProgress) reportProgress(i, bytes_sent, totalBytes);
            }
            if (this.IS_STUB) {
                await this.read_reg({addr:this.CHIP_DETECT_MAGIC_REG_ADDR, timeout:timeout});
            }
            d = new Date();
            let t = d.getTime() - t1;
            if (compress) {
                this.log("Wrote " + uncsize + " bytes (" + bytes_sent + " compressed) at 0x" + address.toString(16) + " in "+(t/1000)+" seconds.");
            }
            if (calculateMD5Hash) {
                let res = await this.flash_md5sum(address, uncsize);
                if (new String(res).valueOf() != new String(calcmd5).valueOf()) {
                    this.log("File  md5: " + calcmd5);
                    this.log("Flash md5: " + res);
                    throw new ESPError("MD5 of file does not match data in flash!")
                } else {
                    this.log("Hash of data verified.");
                }
            }
        }
        this.log("Leaving...");

        if (this.IS_STUB) {
            await this.flash_begin(0, 0);
            if (compress) {
                await this.flash_defl_finish();
            } else {
                await this.flash_finish();
            }
        }
    }

    async flash_id() {
        console.log("flash_id");
        var flashid = await this.read_flash_id();
        this.log("Manufacturer: " + (flashid & 0xff).toString(16));
        var flid_lowbyte = (flashid >> 16) & 0xff;
        this.log("Device: "+((flashid >> 8) & 0xff).toString(16) + flid_lowbyte.toString(16));
        this.log("Detected flash size: " + this.DETECTED_FLASH_SIZES[flid_lowbyte]);
    }

    async hard_reset() {
        this.transport.setRTS(true);  // EN->LOW
        await this._sleep(100);
        this.transport.setRTS(false);
    }

    async soft_reset() {
        if (!this.IS_STUB) {
            // 'run user code' is as close to a soft reset as we can do
            this.flash_begin(0, 0);
            this.flash_finish(false);
        } else if (this.chip.CHIP_NAME != "ESP8266") {
            throw new ESPError("Soft resetting is currently only supported on ESP8266");
        } else {
            // running user code from stub loader requires some hacks
            // in the stub loader
            this.command({op: this.ESP_RUN_USER_CODE, wait_response: false});
        }
    }
}


export { ESPLoader };
