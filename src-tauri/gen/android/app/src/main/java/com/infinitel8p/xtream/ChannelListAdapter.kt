package com.infinitel8p.xtream

import android.graphics.Color
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView
import coil.dispose
import coil.load

/**
 * Channel-list adapter for the VideoActivity D-pad overlay.
 *
 * Rows are 56dp tall, focusable, and highlight the currently-playing channel
 * via the row background. Clicks (or D-pad OK) fire [onPick] with the row's
 * index in the list.
 */
class ChannelListAdapter(
  private val items: List<ChannelLite>,
  private var currentIndex: Int,
  private val onPick: (index: Int) -> Unit,
) : RecyclerView.Adapter<ChannelListAdapter.VH>() {

  override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
    val view = LayoutInflater.from(parent.context)
      .inflate(R.layout.row_channel, parent, false)
    return VH(view)
  }

  override fun onBindViewHolder(holder: VH, position: Int) {
    val item = items[position]
    holder.bind(item, position == currentIndex)
    holder.itemView.setOnClickListener { onPick(position) }
  }

  // Payload-aware rebind: selection-only updates avoid re-loading the logo
  // when the user flips between channels with the D-pad
  override fun onBindViewHolder(holder: VH, position: Int, payloads: MutableList<Any>) {
    if (payloads.contains(PAYLOAD_SELECTION)) {
      holder.bindSelection(position == currentIndex)
      return
    }
    super.onBindViewHolder(holder, position, payloads)
  }

  override fun getItemCount(): Int = items.size

  fun updateCurrentIndex(next: Int) {
    val prev = currentIndex
    currentIndex = next
    if (prev >= 0) notifyItemChanged(prev, PAYLOAD_SELECTION)
    if (next >= 0) notifyItemChanged(next, PAYLOAD_SELECTION)
  }

  inner class VH(view: View) : RecyclerView.ViewHolder(view) {
    private val root: LinearLayout = view.findViewById(R.id.channel_row_root)
    private val logo: ImageView = view.findViewById(R.id.channel_logo)
    private val nameView: TextView = view.findViewById(R.id.channel_name)
    private val nowView: TextView = view.findViewById(R.id.channel_now)

    fun bind(item: ChannelLite, isCurrent: Boolean) {
      nameView.text = item.name
      if (item.nowProgramme.isNotBlank()) {
        nowView.visibility = View.VISIBLE
        nowView.text = item.nowProgramme
      } else {
        nowView.visibility = View.GONE
      }

      if (item.logo.isNotBlank()) {
        logo.load(item.logo) {
          size(logoSizePx(logo))
          crossfade(true)
        }
      } else {
        logo.dispose()
        logo.setImageDrawable(null)
      }

      itemView.contentDescription = buildString {
        append(item.name)
        if (item.nowProgramme.isNotBlank()) {
          append(". ")
          append(item.nowProgramme)
        }
      }
      logo.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      nameView.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      nowView.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO

      bindSelection(isCurrent)
    }

    fun bindSelection(isCurrent: Boolean) {
      val bgColor =
        if (isCurrent) ContextCompat.getColor(itemView.context, R.color.xt_row_bg_selected)
        else Color.TRANSPARENT
      root.setBackgroundColor(bgColor)
    }
  }

  companion object {
    private const val PAYLOAD_SELECTION = "selection"

    private fun logoSizePx(view: View): Int {
      return (40 * view.resources.displayMetrics.density).toInt().coerceAtLeast(1)
    }
  }
}
