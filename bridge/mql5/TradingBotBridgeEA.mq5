//+------------------------------------------------------------------+
//|                                            TradingBotBridgeEA.mq5 |
//|                       File-backed MT5 bridge for the trading bot. |
//+------------------------------------------------------------------+
#property strict

#include <Trade/Trade.mqh>

input string BridgeRoot = "trading-bot-bridge";
input int PollIntervalMs = 250;

CTrade trade;

//+------------------------------------------------------------------+
string TrimValue(string value)
  {
   StringTrimLeft(value);
   StringTrimRight(value);
   return(value);
  }

//+------------------------------------------------------------------+
string UpperValue(string value)
  {
   StringToUpper(value);
   return(value);
  }

//+------------------------------------------------------------------+
string LowerValue(string value)
  {
   StringToLower(value);
   return(value);
  }

//+------------------------------------------------------------------+
string EscapeValue(string value)
  {
   StringReplace(value,"\\","\\\\");
   StringReplace(value,"\r","\\r");
   StringReplace(value,"\n","\\n");
   return(value);
  }

//+------------------------------------------------------------------+
string UnescapeValue(string value)
  {
   string result="";
   int length=StringLen(value);
   int index=0;

   while(index<length)
     {
      ushort ch=StringGetCharacter(value,index);

      if(ch=='\\' && index+1<length)
        {
         ushort next=StringGetCharacter(value,index+1);

         if(next=='n')
           {
            result+="\n";
            index+=2;
            continue;
           }

         if(next=='r')
           {
            result+="\r";
            index+=2;
            continue;
           }

         if(next=='\\')
           {
            result+="\\";
            index+=2;
            continue;
           }
        }

      result+=CharToString((uchar)ch);
      index++;
     }

   return(result);
  }

//+------------------------------------------------------------------+
void AddLine(string &lines[],const string line)
  {
   int size=ArraySize(lines);
   ArrayResize(lines,size+1);
   lines[size]=line;
  }

//+------------------------------------------------------------------+
void AddField(string &lines[],const string key,const string value)
  {
   AddLine(lines,key+"="+EscapeValue(value));
  }

//+------------------------------------------------------------------+
void AddBoolField(string &lines[],const string key,const bool value)
  {
   AddField(lines,key,value ? "true" : "false");
  }

//+------------------------------------------------------------------+
void AddIntField(string &lines[],const string key,const long value)
  {
   AddField(lines,key,StringFormat("%I64d",value));
  }

//+------------------------------------------------------------------+
void AddDoubleField(string &lines[],const string key,const double value,const int digits=8)
  {
   AddField(lines,key,DoubleToString(value,digits));
  }

//+------------------------------------------------------------------+
void AddMapValue(string &keys[],string &values[],const string key,const string value)
  {
   int size=ArraySize(keys);
   ArrayResize(keys,size+1);
   ArrayResize(values,size+1);
   keys[size]=key;
   values[size]=value;
  }

//+------------------------------------------------------------------+
string GetMapValue(const string &keys[],const string &values[],const string key,const string fallback="")
  {
   for(int index=0; index<ArraySize(keys); index++)
     {
      if(keys[index]==key)
         return(values[index]);
     }

   return(fallback);
  }

//+------------------------------------------------------------------+
bool EnsureFolders()
  {
   FolderCreate(BridgeRoot,FILE_COMMON);
   FolderCreate(BridgeRoot+"\\requests",FILE_COMMON);
   FolderCreate(BridgeRoot+"\\processing",FILE_COMMON);
   FolderCreate(BridgeRoot+"\\responses",FILE_COMMON);
   FolderCreate(BridgeRoot+"\\status",FILE_COMMON);
   return(true);
  }

//+------------------------------------------------------------------+
bool ReadKeyValueFile(const string relative_path,string &keys[],string &values[])
  {
   ArrayResize(keys,0);
   ArrayResize(values,0);

   int handle=FileOpen(relative_path,FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON,'\n',CP_UTF8);

   if(handle==INVALID_HANDLE)
      return(false);

   while(!FileIsEnding(handle))
     {
      string line=TrimValue(FileReadString(handle));

      if(line=="" || StringGetCharacter(line,0)=='#')
         continue;

      int split_index=StringFind(line,"=");

      if(split_index<0)
         continue;

      string key=TrimValue(StringSubstr(line,0,split_index));
      string value=UnescapeValue(StringSubstr(line,split_index+1));
      AddMapValue(keys,values,key,value);
     }

   FileClose(handle);
   return(true);
  }

//+------------------------------------------------------------------+
bool WriteLines(const string relative_path,string &lines[])
  {
   int handle=FileOpen(relative_path,FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON,'\n',CP_UTF8);

   if(handle==INVALID_HANDLE)
      return(false);

   for(int index=0; index<ArraySize(lines); index++)
     {
      FileWriteString(handle,lines[index]);
      FileWriteString(handle,"\n");
     }

   FileFlush(handle);
   FileClose(handle);
   return(true);
  }

//+------------------------------------------------------------------+
int VolumeDigits(const double step)
  {
   string text=DoubleToString(step,8);
   int length=StringLen(text);

   while(length>0 && StringGetCharacter(text,length-1)=='0')
     {
      text=StringSubstr(text,0,length-1);
      length=StringLen(text);
     }

   if(length>0 && StringGetCharacter(text,length-1)=='.')
      text=StringSubstr(text,0,length-1);

   int dot_index=StringFind(text,".");

   if(dot_index<0)
      return(0);

   return(StringLen(text)-dot_index-1);
  }

//+------------------------------------------------------------------+
double CurrentNetPosition(const string symbol)
  {
   double buy_volume=0.0;
   double sell_volume=0.0;
   int total=PositionsTotal();

   for(int index=0; index<total; index++)
     {
      ulong ticket=PositionGetTicket(index);

      if(ticket==0 || !PositionSelectByTicket(ticket))
         continue;

      if(PositionGetString(POSITION_SYMBOL)!=symbol)
         continue;

      double volume=PositionGetDouble(POSITION_VOLUME);
      ENUM_POSITION_TYPE type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

      if(type==POSITION_TYPE_SELL)
         sell_volume+=volume;
      else
         buy_volume+=volume;
     }

   return(buy_volume-sell_volume);
  }

//+------------------------------------------------------------------+
bool EnsureSymbolReady(const string symbol,string &error)
  {
   if(symbol=="")
     {
      error="Missing symbol";
      return(false);
     }

   if(!SymbolSelect(symbol,true))
     {
      error="MT5 could not select symbol: "+symbol;
      return(false);
     }

   MqlTick tick;

   if(!SymbolInfoTick(symbol,tick))
     {
      error="MT5 did not return a live tick for "+symbol;
      return(false);
     }

   return(true);
  }

//+------------------------------------------------------------------+
double NormalizeVolumeForSymbol(const string symbol,const double raw_qty,string &error)
  {
   if(raw_qty<=0.0)
     {
      error="Order quantity must be greater than 0";
      return(0.0);
     }

   double volume_min=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN);
   double volume_max=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX);
   double volume_step=SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP);

   if(volume_step<=0.0)
      volume_step=(volume_min>0.0 ? volume_min : 0.01);

   int digits=VolumeDigits(volume_step);
   double qty=raw_qty;

   if(volume_min>0.0 && qty<volume_min)
      qty=volume_min;

   if(volume_max>0.0 && qty>volume_max)
      qty=volume_max;

   double steps=MathRound(qty/volume_step);
   double normalized=NormalizeDouble(steps*volume_step,digits);

   if(volume_min>0.0 && normalized<volume_min)
     {
      error="Normalized volume is below broker minimum";
      return(0.0);
     }

  return(normalized);
  }

//+------------------------------------------------------------------+
void NormalizeStopsForSide(const string symbol,const ENUM_POSITION_TYPE side,double &stop_loss,double &take_profit)
  {
   MqlTick tick;

   if(!SymbolInfoTick(symbol,tick))
      return;

   int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   double point=SymbolInfoDouble(symbol,SYMBOL_POINT);
   int stop_level=(int)SymbolInfoInteger(symbol,SYMBOL_TRADE_STOPS_LEVEL);
   double min_distance=MathMax((double)stop_level,2.0)*point;
   double bid=tick.bid>0.0 ? tick.bid : tick.last;
   double ask=tick.ask>0.0 ? tick.ask : tick.last;

   if(side==POSITION_TYPE_BUY)
     {
      if(stop_loss>0.0)
         stop_loss=NormalizeDouble(MathMin(stop_loss,bid-min_distance),digits);

      if(take_profit>0.0)
         take_profit=NormalizeDouble(MathMax(take_profit,ask+min_distance),digits);
     }
   else
     {
      if(stop_loss>0.0)
         stop_loss=NormalizeDouble(MathMax(stop_loss,ask+min_distance),digits);

      if(take_profit>0.0)
         take_profit=NormalizeDouble(MathMin(take_profit,bid-min_distance),digits);
     }
  }

//+------------------------------------------------------------------+
void AddAccountFields(string &lines[],const string symbol)
  {
   double position=CurrentNetPosition(symbol);
   AddDoubleField(lines,"cash",AccountInfoDouble(ACCOUNT_MARGIN_FREE),2);
   AddDoubleField(lines,"balance",AccountInfoDouble(ACCOUNT_BALANCE),2);
   AddDoubleField(lines,"equity",AccountInfoDouble(ACCOUNT_EQUITY),2);
   AddDoubleField(lines,"marginFree",AccountInfoDouble(ACCOUNT_MARGIN_FREE),2);
   AddDoubleField(lines,"position",position,8);
   AddDoubleField(lines,"volume",MathAbs(position),8);
  }

//+------------------------------------------------------------------+
double CloseOpposingPositions(const string symbol,const string side,const double requested_qty,const int deviation,string &error,double &fill_price)
  {
   double remaining=requested_qty;
   fill_price=0.0;
   error="";
   int total=PositionsTotal();

   for(int index=total-1; index>=0 && remaining>0.0; index--)
     {
      ulong ticket=PositionGetTicket(index);

      if(ticket==0 || !PositionSelectByTicket(ticket))
         continue;

      if(PositionGetString(POSITION_SYMBOL)!=symbol)
         continue;

      ENUM_POSITION_TYPE type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      bool is_opposite=(side=="BUY" && type==POSITION_TYPE_SELL) || (side=="SELL" && type==POSITION_TYPE_BUY);

      if(!is_opposite)
         continue;

      double position_volume=PositionGetDouble(POSITION_VOLUME);
      long digits=(long)SymbolInfoInteger(symbol,SYMBOL_DIGITS);

      if(position_volume<=remaining+0.0000001)
        {
         if(!trade.PositionClose(ticket,(ulong)deviation))
           {
            error=trade.ResultRetcodeDescription();
            return(requested_qty-remaining);
           }

         if(trade.ResultPrice()>0.0)
            fill_price=trade.ResultPrice();

         remaining-=position_volume;
        }
      else
        {
         double partial_volume=NormalizeDouble(remaining,(int)VolumeDigits(SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP)));

         if(partial_volume<=0.0)
            break;

         if(!trade.PositionClosePartial(ticket,partial_volume,(ulong)deviation))
           {
            error=trade.ResultRetcodeDescription();
            return(requested_qty-remaining);
           }

         if(trade.ResultPrice()>0.0)
            fill_price=trade.ResultPrice();

         remaining=0.0;
        }
     }

   return(requested_qty-remaining);
  }

//+------------------------------------------------------------------+
void BuildErrorResponse(string &lines[],const string request_id,const string message,const int http_status=400)
  {
   AddField(lines,"id",request_id);
   AddField(lines,"status","error");
   AddField(lines,"error",message);
   AddIntField(lines,"httpStatus",http_status);
  }

//+------------------------------------------------------------------+
void WriteHeartbeat(const string status)
  {
   string lines[];
   AddField(lines,"status",status);
   AddIntField(lines,"timestampEpoch",(long)TimeLocal());
   AddField(lines,"timestamp",TimeToString(TimeLocal(),TIME_DATE|TIME_SECONDS));
   AddBoolField(lines,"connected",(bool)TerminalInfoInteger(TERMINAL_CONNECTED));
   AddIntField(lines,"build",(long)TerminalInfoInteger(TERMINAL_BUILD));
   AddField(lines,"terminalPath",TerminalInfoString(TERMINAL_PATH));
   AddField(lines,"dataPath",TerminalInfoString(TERMINAL_DATA_PATH));
   AddField(lines,"commonDataPath",TerminalInfoString(TERMINAL_COMMONDATA_PATH));
   AddIntField(lines,"login",(long)AccountInfoInteger(ACCOUNT_LOGIN));
   AddField(lines,"server",AccountInfoString(ACCOUNT_SERVER));
   AddField(lines,"company",AccountInfoString(ACCOUNT_COMPANY));
   WriteLines(BridgeRoot+"\\status\\heartbeat.txt",lines);
  }

//+------------------------------------------------------------------+
void HandleHealth(const string request_id,string &lines[])
  {
   AddField(lines,"id",request_id);
   AddField(lines,"status","ok");
   AddBoolField(lines,"connected",(bool)TerminalInfoInteger(TERMINAL_CONNECTED));
   AddIntField(lines,"build",(long)TerminalInfoInteger(TERMINAL_BUILD));
   AddField(lines,"terminalPath",TerminalInfoString(TERMINAL_PATH));
   AddField(lines,"dataPath",TerminalInfoString(TERMINAL_DATA_PATH));
   AddField(lines,"commonDataPath",TerminalInfoString(TERMINAL_COMMONDATA_PATH));
   AddIntField(lines,"accountLogin",(long)AccountInfoInteger(ACCOUNT_LOGIN));
   AddField(lines,"server",AccountInfoString(ACCOUNT_SERVER));
   AddField(lines,"company",AccountInfoString(ACCOUNT_COMPANY));
  }

//+------------------------------------------------------------------+
bool HandleQuote(const string request_id,const string &keys[],const string &values[],string &lines[])
  {
   string symbol=TrimValue(GetMapValue(keys,values,"symbol"));
   string error="";
   int symbol_digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);

   if(!EnsureSymbolReady(symbol,error))
     {
      BuildErrorResponse(lines,request_id,error,404);
      return(false);
     }

   MqlTick tick;

   if(!SymbolInfoTick(symbol,tick))
     {
      BuildErrorResponse(lines,request_id,"MT5 did not return a live tick for "+symbol,503);
      return(false);
     }

   double price=(tick.bid>0.0 && tick.ask>0.0) ? (tick.bid+tick.ask)/2.0 : (tick.last>0.0 ? tick.last : (tick.ask>0.0 ? tick.ask : tick.bid));

   AddField(lines,"id",request_id);
   AddField(lines,"status","ok");
   AddField(lines,"symbol",symbol);
   AddDoubleField(lines,"bid",tick.bid,symbol_digits);
   AddDoubleField(lines,"ask",tick.ask,symbol_digits);
   AddDoubleField(lines,"last",tick.last,symbol_digits);
   AddDoubleField(lines,"price",price,symbol_digits);
   AddIntField(lines,"time",(long)tick.time);
   return(true);
  }

//+------------------------------------------------------------------+
bool HandleAccount(const string request_id,const string &keys[],const string &values[],string &lines[])
  {
   string symbol=TrimValue(GetMapValue(keys,values,"symbol"));

   AddField(lines,"id",request_id);
   AddField(lines,"status","ok");
   AddField(lines,"symbol",symbol);
   AddAccountFields(lines,symbol);
   return(true);
  }

//+------------------------------------------------------------------+
bool HandleSymbols(const string request_id,const string &keys[],const string &values[],string &lines[])
  {
   string filter=UpperValue(TrimValue(GetMapValue(keys,values,"filter")));
   int total=SymbolsTotal(false);
   string matched="";
   int matched_count=0;

   for(int index=0; index<total; index++)
     {
      string symbol=SymbolName(index,false);
      string normalized=UpperValue(symbol);

      if(filter!="" && StringFind(normalized,filter)<0)
         continue;

      if(matched!="")
         matched+="|";

      matched+=symbol;
      matched_count++;
     }

   AddField(lines,"id",request_id);
   AddField(lines,"status","ok");
   AddField(lines,"filter",filter);
   AddIntField(lines,"count",matched_count);
   AddField(lines,"symbols",matched);
  return(true);
  }

//+------------------------------------------------------------------+
bool HandleSymbolInfo(const string request_id,const string &keys[],const string &values[],string &lines[])
  {
   string symbol=TrimValue(GetMapValue(keys,values,"symbol"));
   string error="";

   if(!EnsureSymbolReady(symbol,error))
     {
      BuildErrorResponse(lines,request_id,error,404);
      return(false);
     }

   MqlTick tick;
   SymbolInfoTick(symbol,tick);

   AddField(lines,"id",request_id);
   AddField(lines,"status","ok");
   AddField(lines,"symbol",symbol);
   AddIntField(lines,"digits",(long)SymbolInfoInteger(symbol,SYMBOL_DIGITS));
   AddDoubleField(lines,"point",SymbolInfoDouble(symbol,SYMBOL_POINT),8);
   AddIntField(lines,"stopsLevel",(long)SymbolInfoInteger(symbol,SYMBOL_TRADE_STOPS_LEVEL));
   AddIntField(lines,"freezeLevel",(long)SymbolInfoInteger(symbol,SYMBOL_TRADE_FREEZE_LEVEL));
   AddDoubleField(lines,"bid",tick.bid,(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS));
   AddDoubleField(lines,"ask",tick.ask,(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS));
   AddDoubleField(lines,"last",tick.last,(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS));
   return(true);
  }

//+------------------------------------------------------------------+
bool HandleHistory(const string request_id,const string &keys[],const string &values[],string &lines[])
  {
   string symbol=TrimValue(GetMapValue(keys,values,"symbol"));
   datetime from_time=(datetime)StringToInteger(GetMapValue(keys,values,"fromEpoch","0"));
   datetime to_time=(datetime)StringToInteger(GetMapValue(keys,values,"toEpoch","0"));
   int limit=(int)StringToInteger(GetMapValue(keys,values,"limit","50"));

   if(limit<=0)
      limit=50;

   if(to_time<=0)
      to_time=TimeCurrent()+60;

   if(from_time<=0)
      from_time=to_time-(datetime)(7*24*60*60);

   if(!HistorySelect(from_time,to_time))
     {
      BuildErrorResponse(lines,request_id,"MT5 could not read account history",500);
      return(false);
     }

   int total=HistoryDealsTotal();
   int added=0;

   AddField(lines,"id",request_id);
   AddField(lines,"status","ok");
   AddField(lines,"symbol",symbol);

   for(int index=total-1; index>=0 && added<limit; index--)
     {
      ulong ticket=HistoryDealGetTicket(index);

      if(ticket==0)
         continue;

      string deal_symbol=HistoryDealGetString(ticket,DEAL_SYMBOL);

      if(symbol!="" && deal_symbol!=symbol)
         continue;

      int entry=(int)HistoryDealGetInteger(ticket,DEAL_ENTRY);
      int type=(int)HistoryDealGetInteger(ticket,DEAL_TYPE);
      double volume=HistoryDealGetDouble(ticket,DEAL_VOLUME);
      double price=HistoryDealGetDouble(ticket,DEAL_PRICE);
      double profit=HistoryDealGetDouble(ticket,DEAL_PROFIT);
      long time_value=(long)HistoryDealGetInteger(ticket,DEAL_TIME);
      string comment=HistoryDealGetString(ticket,DEAL_COMMENT);
      long magic=(long)HistoryDealGetInteger(ticket,DEAL_MAGIC);
      long position_id=(long)HistoryDealGetInteger(ticket,DEAL_POSITION_ID);
      string serialized=
         StringFormat("%I64d",(long)ticket)+"|"
         +deal_symbol+"|"
         +IntegerToString(entry)+"|"
         +IntegerToString(type)+"|"
         +DoubleToString(volume,8)+"|"
         +DoubleToString(price,(int)SymbolInfoInteger(deal_symbol,SYMBOL_DIGITS))+"|"
         +DoubleToString(profit,2)+"|"
         +StringFormat("%I64d",time_value)+"|"
         +comment+"|"
         +StringFormat("%I64d",magic)+"|"
         +StringFormat("%I64d",position_id);

      AddField(lines,"deal"+IntegerToString(added),serialized);
      added++;
     }

   AddIntField(lines,"count",added);
  return(true);
  }

//+------------------------------------------------------------------+
ENUM_TIMEFRAMES ParseTimeframe(const string timeframe)
  {
   string normalized=UpperValue(TrimValue(timeframe));

   if(normalized=="M1") return PERIOD_M1;
   if(normalized=="M5") return PERIOD_M5;
   if(normalized=="M15") return PERIOD_M15;
   if(normalized=="M30") return PERIOD_M30;
   if(normalized=="H1") return PERIOD_H1;
   if(normalized=="H4") return PERIOD_H4;
   if(normalized=="D1") return PERIOD_D1;
   return PERIOD_M15;
  }

//+------------------------------------------------------------------+
bool HandleBars(const string request_id,const string &keys[],const string &values[],string &lines[])
  {
   string symbol=TrimValue(GetMapValue(keys,values,"symbol"));
   string timeframe_text=TrimValue(GetMapValue(keys,values,"timeframe","M15"));
   int count=(int)StringToInteger(GetMapValue(keys,values,"count","250"));
   string error="";

   if(!EnsureSymbolReady(symbol,error))
     {
      BuildErrorResponse(lines,request_id,error,404);
      return(false);
     }

   if(count<=0)
      count=250;

   MqlRates rates[];
   ENUM_TIMEFRAMES timeframe=ParseTimeframe(timeframe_text);
   int copied=CopyRates(symbol,timeframe,0,count,rates);

   if(copied<=0)
     {
      BuildErrorResponse(lines,request_id,"MT5 could not load historical bars for "+symbol,500);
      return(false);
     }

   ArraySetAsSeries(rates,false);
   int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);

   AddField(lines,"id",request_id);
   AddField(lines,"status","ok");
   AddField(lines,"symbol",symbol);
   AddField(lines,"timeframe",timeframe_text);
   AddIntField(lines,"count",copied);

   for(int index=0; index<copied; index++)
     {
      string serialized=
         StringFormat("%I64d",(long)rates[index].time)+"|"
         +DoubleToString(rates[index].open,digits)+"|"
         +DoubleToString(rates[index].high,digits)+"|"
         +DoubleToString(rates[index].low,digits)+"|"
         +DoubleToString(rates[index].close,digits)+"|"
         +StringFormat("%I64d",(long)rates[index].tick_volume);
      AddField(lines,"bar"+IntegerToString(index),serialized);
     }

   return(true);
  }

//+------------------------------------------------------------------+
bool HandleOrder(const string request_id,const string &keys[],const string &values[],string &lines[])
  {
   string symbol=TrimValue(GetMapValue(keys,values,"symbol"));
   string side=UpperValue(TrimValue(GetMapValue(keys,values,"side")));
   double qty=StringToDouble(GetMapValue(keys,values,"qty","0"));
   int deviation=(int)StringToInteger(GetMapValue(keys,values,"deviation","20"));
   long magic=(long)StringToInteger(GetMapValue(keys,values,"magic","5151001"));
   string comment=TrimValue(GetMapValue(keys,values,"comment","trading-bot"));
   double expected_price=StringToDouble(GetMapValue(keys,values,"expectedPrice","0"));
   double stop_loss=StringToDouble(GetMapValue(keys,values,"stopLoss","0"));
   double take_profit=StringToDouble(GetMapValue(keys,values,"takeProfit","0"));
   int symbol_digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   string error="";

   if(side!="BUY" && side!="SELL")
     {
      BuildErrorResponse(lines,request_id,"Order side must be BUY or SELL",400);
      return(false);
     }

   if(!EnsureSymbolReady(symbol,error))
     {
      BuildErrorResponse(lines,request_id,error,404);
      return(false);
     }

   double normalized_qty=NormalizeVolumeForSymbol(symbol,qty,error);

   if(normalized_qty<=0.0)
     {
      BuildErrorResponse(lines,request_id,error,400);
      return(false);
     }

   MqlTick tick;

   if(!SymbolInfoTick(symbol,tick))
     {
      BuildErrorResponse(lines,request_id,"MT5 did not return a live tick for "+symbol,503);
      return(false);
     }

   double validated_price=(side=="BUY")
                           ? (tick.ask>0.0 ? tick.ask : tick.last)
                           : (tick.bid>0.0 ? tick.bid : tick.last);
   ENUM_POSITION_TYPE target_side=(side=="BUY") ? POSITION_TYPE_BUY : POSITION_TYPE_SELL;
   NormalizeStopsForSide(symbol,target_side,stop_loss,take_profit);

   trade.SetAsyncMode(false);
   trade.SetExpertMagicNumber((ulong)magic);
   trade.SetDeviationInPoints((ulong)deviation);
   trade.SetTypeFillingBySymbol(symbol);
   double fill_price=0.0;
   string close_error="";
   double closed_qty=CloseOpposingPositions(symbol,side,normalized_qty,deviation,close_error,fill_price);
   double remaining_qty=normalized_qty-closed_qty;
   bool ok=true;

   if(close_error!="")
     {
      BuildErrorResponse(lines,request_id,close_error,400);
      AddIntField(lines,"retcode",(long)trade.ResultRetcode());
      AddField(lines,"retcodeDescription",trade.ResultRetcodeDescription());
      AddField(lines,"resultComment",trade.ResultComment());
      return(false);
     }

   if(remaining_qty>0.0000001)
     {
      ok=(side=="BUY")
         ? trade.Buy(remaining_qty,symbol,0.0,stop_loss,take_profit,comment)
         : trade.Sell(remaining_qty,symbol,0.0,stop_loss,take_profit,comment);
     }

   if(!ok)
     {
      BuildErrorResponse(lines,request_id,trade.ResultRetcodeDescription(),400);
      AddIntField(lines,"retcode",(long)trade.ResultRetcode());
      AddField(lines,"retcodeDescription",trade.ResultRetcodeDescription());
      AddField(lines,"resultComment",trade.ResultComment());
      return(false);
     }

   if(trade.ResultPrice()>0.0)
      fill_price=trade.ResultPrice();

   if(fill_price<=0.0)
      fill_price=(validated_price>0.0 ? validated_price : expected_price);

   AddField(lines,"id",request_id);
   AddField(lines,"status","ok");
   AddField(lines,"symbol",symbol);
   AddField(lines,"side",side);
   AddDoubleField(lines,"qty",normalized_qty,8);
   AddDoubleField(lines,"closedQty",closed_qty,8);
   AddDoubleField(lines,"openedQty",remaining_qty>0.0 ? remaining_qty : 0.0,8);
   AddDoubleField(lines,"expectedPrice",expected_price,symbol_digits);
   AddDoubleField(lines,"stopLoss",stop_loss,symbol_digits);
   AddDoubleField(lines,"takeProfit",take_profit,symbol_digits);
   AddDoubleField(lines,"validatedPrice",validated_price,symbol_digits);
   AddDoubleField(lines,"fillPrice",fill_price,symbol_digits);
   AddIntField(lines,"retcode",(long)trade.ResultRetcode());
   AddField(lines,"retcodeDescription",trade.ResultRetcodeDescription());
   AddField(lines,"resultComment",trade.ResultComment());
   AddField(lines,"broker","mt5-native");
   AddAccountFields(lines,symbol);
   return(true);
  }

//+------------------------------------------------------------------+
bool HandleModify(const string request_id,const string &keys[],const string &values[],string &lines[])
  {
   string symbol=TrimValue(GetMapValue(keys,values,"symbol"));
   string side=UpperValue(TrimValue(GetMapValue(keys,values,"side")));
   double stop_loss=StringToDouble(GetMapValue(keys,values,"stopLoss","0"));
   double take_profit=StringToDouble(GetMapValue(keys,values,"takeProfit","0"));
   int symbol_digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   int total=PositionsTotal();
   int modified=0;
   MqlTick tick;
   SymbolInfoTick(symbol,tick);

   for(int index=0; index<total; index++)
     {
      ulong ticket=PositionGetTicket(index);

      if(ticket==0 || !PositionSelectByTicket(ticket))
         continue;

      if(PositionGetString(POSITION_SYMBOL)!=symbol)
         continue;

      ENUM_POSITION_TYPE type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

      if(side=="BUY" && type!=POSITION_TYPE_BUY)
         continue;

      if(side=="SELL" && type!=POSITION_TYPE_SELL)
         continue;

      double adjusted_stop=stop_loss;
      double adjusted_take=take_profit;
      NormalizeStopsForSide(symbol,type,adjusted_stop,adjusted_take);

      if(!trade.PositionModify(ticket,adjusted_stop,adjusted_take))
        {
         BuildErrorResponse(lines,request_id,trade.ResultRetcodeDescription(),400);
         AddIntField(lines,"retcode",(long)trade.ResultRetcode());
         AddField(lines,"retcodeDescription",trade.ResultRetcodeDescription());
         AddField(lines,"resultComment",trade.ResultComment());
         AddField(lines,"positionType",type==POSITION_TYPE_SELL ? "SELL" : "BUY");
         AddDoubleField(lines,"requestedStopLoss",stop_loss,symbol_digits);
         AddDoubleField(lines,"requestedTakeProfit",take_profit,symbol_digits);
         AddDoubleField(lines,"adjustedStopLoss",adjusted_stop,symbol_digits);
         AddDoubleField(lines,"adjustedTakeProfit",adjusted_take,symbol_digits);
         AddDoubleField(lines,"positionPriceOpen",PositionGetDouble(POSITION_PRICE_OPEN),symbol_digits);
         AddDoubleField(lines,"positionCurrentStopLoss",PositionGetDouble(POSITION_SL),symbol_digits);
         AddDoubleField(lines,"positionCurrentTakeProfit",PositionGetDouble(POSITION_TP),symbol_digits);
         AddDoubleField(lines,"bid",tick.bid,symbol_digits);
         AddDoubleField(lines,"ask",tick.ask,symbol_digits);
         AddDoubleField(lines,"point",SymbolInfoDouble(symbol,SYMBOL_POINT),8);
         AddIntField(lines,"stopsLevel",(long)SymbolInfoInteger(symbol,SYMBOL_TRADE_STOPS_LEVEL));
         AddIntField(lines,"freezeLevel",(long)SymbolInfoInteger(symbol,SYMBOL_TRADE_FREEZE_LEVEL));
         return(false);
        }

      modified++;
     }

   AddField(lines,"id",request_id);
   AddField(lines,"status","ok");
   AddField(lines,"symbol",symbol);
   AddDoubleField(lines,"stopLoss",stop_loss,symbol_digits);
   AddDoubleField(lines,"takeProfit",take_profit,symbol_digits);
   AddIntField(lines,"modified",(long)modified);
   AddField(lines,"broker","mt5-native");
   AddAccountFields(lines,symbol);
   return(true);
  }

//+------------------------------------------------------------------+
void ProcessRequestFile(const string filename)
  {
   string request_path=BridgeRoot+"\\requests\\"+filename;
   string processing_path=BridgeRoot+"\\processing\\"+filename;
   string keys[];
   string values[];

   if(!FileMove(request_path,FILE_COMMON,processing_path,FILE_COMMON))
      return;

   if(!ReadKeyValueFile(processing_path,keys,values))
     {
      FileDelete(processing_path,FILE_COMMON);
      return;
     }

   string request_id=TrimValue(GetMapValue(keys,values,"id"));
   string action=LowerValue(TrimValue(GetMapValue(keys,values,"action")));
   string lines[];

   if(request_id=="")
     {
      FileDelete(processing_path,FILE_COMMON);
      return;
     }

   if(action=="health")
      HandleHealth(request_id,lines);
   else if(action=="quote")
      HandleQuote(request_id,keys,values,lines);
   else if(action=="symbols")
      HandleSymbols(request_id,keys,values,lines);
   else if(action=="symbol_info")
      HandleSymbolInfo(request_id,keys,values,lines);
   else if(action=="history")
      HandleHistory(request_id,keys,values,lines);
   else if(action=="bars")
      HandleBars(request_id,keys,values,lines);
   else if(action=="account")
      HandleAccount(request_id,keys,values,lines);
   else if(action=="modify")
      HandleModify(request_id,keys,values,lines);
   else if(action=="order")
      HandleOrder(request_id,keys,values,lines);
   else
      BuildErrorResponse(lines,request_id,"Unsupported action: "+action,404);

   WriteLines(BridgeRoot+"\\responses\\"+request_id+".res",lines);
   FileDelete(processing_path,FILE_COMMON);
  }

//+------------------------------------------------------------------+
void ProcessRequests()
  {
   string filename;
   long finder=FileFindFirst(BridgeRoot+"\\requests\\*.req",filename,FILE_COMMON);

   if(finder==INVALID_HANDLE)
      return;

   do
     {
      ProcessRequestFile(filename);
     }
   while(FileFindNext(finder,filename));

   FileFindClose(finder);
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   EnsureFolders();
   EventSetMillisecondTimer(MathMax(PollIntervalMs,100));
   WriteHeartbeat("ok");
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   WriteHeartbeat("stopped");
  }

//+------------------------------------------------------------------+
void OnTick()
  {
  }

//+------------------------------------------------------------------+
void OnTimer()
  {
   EnsureFolders();
   WriteHeartbeat("ok");
   ProcessRequests();
  }
//+------------------------------------------------------------------+
